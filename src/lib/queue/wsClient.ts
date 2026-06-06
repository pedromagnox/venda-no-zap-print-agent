import WebSocket from 'ws'
import type { TokenManager } from '@lib/auth/tokenManager'
import type { AgentState } from '@main/agentState'
import { formatLogTime } from '@shared/logTime'

// Cliente WebSocket do v1.0.0 ("campainha"). Conecta no Worker
// (wss://vendanozap.app/api/print-agent/ws) com o access token no header, e ao
// receber {type:"job"} chama onJob() — que dispara um tick imediato do
// QueueLoop. O claim/print/ack seguem em HTTP (intactos). Reconexão com backoff;
// ping de keepalive pra não cair em NAT. No-op se url vazia (dev/mock).
//
// O token é validado pelo Worker SÓ no upgrade (HMAC). A conexão fica válida
// mesmo após o access token expirar (15min) — não precisa refresh em vôo; o
// refresh acontece naturalmente no getAccessToken() de uma reconexão.

export type WsClientDeps = {
  url: string
  tokens: TokenManager
  state: AgentState
  onJob: () => void
  onConnected: () => void
  onDisconnected: () => void
}

const PING_INTERVAL_MS = 30_000
// v1.7.0: se o pong não chega em 10s após o ping, presumimos que a conexão
// está "fantasma" — TCP aberto mas a outra ponta não responde. Acontece em
// Modern Standby do Windows 11 (S0ix) com Wi-Fi Intel AX2xx: a NIC entra em
// low-power, o TCP socket permanece "OPEN" mas nada trafega; sem isso, o
// agente ficava acreditando que o WS estava ativo enquanto na verdade os
// pushes nunca chegavam.
const PONG_TIMEOUT_MS = 10_000
const MAX_BACKOFF_MS = 60_000

export class WsClient {
  private ws: WebSocket | null = null
  private active = false
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: WsClientDeps) {}

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  start(): void {
    if (this.active) return
    if (!this.deps.url) return // WS desabilitado (dev/mock — backend é só HTTP)
    this.active = true
    void this.connect()
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close(1000)
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private async connect(): Promise<void> {
    if (!this.active) return

    let token: string
    try {
      token = await this.deps.tokens.getAccessToken()
    } catch {
      // Sem token (não conectado / refresh falhou). Reconecta com backoff —
      // se o refresh foi rejeitado de vez, o main para o WsClient via stop().
      this.scheduleReconnect()
      return
    }

    const ws = new WebSocket(this.deps.url, {
      headers: { Authorization: `Bearer ${token}` }
    })
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempts = 0
      this.deps.state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: 'WebSocket conectado — recebendo pedidos por push.'
      })
      this.startPing()
      this.deps.onConnected()
    })

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: { type?: string }
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'job') this.deps.onJob()
      // 'connected' (hello do DO) e outros: no-op.
    })

    ws.on('pong', () => {
      // Pong recebido — limpa o timer; conexão está viva.
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    })

    ws.on('close', () => {
      this.clearTimers()
      this.ws = null
      this.deps.state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: 'WebSocket desconectado — voltando pro polling até reconectar.'
      })
      this.deps.onDisconnected()
      if (this.active) this.scheduleReconnect()
    })

    ws.on('error', () => {
      // O 'close' vem logo em seguida e cuida do reconnect. Só garante o close.
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    })
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    // Ping de protocolo (frame), respondido pelo runtime da CF sem acordar o DO
    // hibernado — mantém a conexão viva através de NAT/firewall do lojista.
    // v1.7.0: também arma um timer de pong; se não chegar em PONG_TIMEOUT_MS,
    // assumimos conexão "fantasma" e forçamos reconexão.
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping()
          if (this.pongTimer) clearTimeout(this.pongTimer)
          this.pongTimer = setTimeout(() => {
            this.pongTimer = null
            this.deps.state.pushLog({
              time: formatLogTime(),
              level: 'warn',
              message:
                'WebSocket não respondeu ao keep-alive — reconectando (provável Modern Standby do Windows).'
            })
            try {
              this.ws?.terminate()
            } catch {
              /* ignore */
            }
          }, PONG_TIMEOUT_MS)
        } catch {
          /* ignore */
        }
      }
    }, PING_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return
    this.reconnectAttempts++
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.min(this.reconnectAttempts - 1, 6)
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, backoff)
  }
}
