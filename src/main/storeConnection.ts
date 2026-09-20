import type Database from 'better-sqlite3'
import { ApiClient, rawPostJson } from '@lib/api/client'
import { PrintAgentEndpoints } from '@lib/api/endpoints'
import { TokenManager, type ExchangeResult } from '@lib/auth/tokenManager'
import type { DeviceFingerprint } from '@lib/auth/device'
import { LocalQueue } from '@lib/queue/localQueue'
import { QueueLoop } from '@lib/queue/queueLoop'
import { WsClient } from '@lib/queue/wsClient'
import { TelemetryBuffer } from '@lib/telemetry/buffer'
import { TelemetryService } from '@lib/telemetry/service'
import { Heartbeat } from '@lib/telemetry/heartbeat'
import { config } from '@lib/config'
import type { PrinterConfig } from '@shared/types'
import { formatLogTime } from '@shared/logTime'
import type { AgentState } from './agentState'

// v1.11.0: tudo que é POR LOJA vive aqui — token, endpoints, telemetria,
// heartbeat, fila e WebSocket. O que é da MÁQUINA (impressora, preferências,
// banco local, logs, bandeja) continua único e é injetado de fora.
//
// Uma instalação passa a ter N destes, um por loja conectada. É o que permite
// o lojista com duas lojas e uma impressora só receber pedidos das duas ao
// mesmo tempo, em vez de trocar o token toda hora.

export type StoreConnectionDeps = {
  db: Database.Database
  state: AgentState
  device: DeviceFingerprint
  appVersion: string
  getPrinterConfig: () => PrinterConfig
  /** Serializa o acesso à impressora entre TODAS as lojas (uma impressora só). */
  withPrinter: <T>(fn: () => Promise<T>) => Promise<T>
  /** Primeira loja da lista: adota as linhas sqlite gravadas antes da
   *  atualização, que não têm store_id. */
  adoptsLegacyRows: boolean
}

export class StoreConnection {
  readonly tokens: TokenManager
  readonly endpoints: PrintAgentEndpoints
  readonly telemetry: TelemetryService
  private readonly heartbeat: Heartbeat
  private readonly queueLoop: QueueLoop
  private readonly wsClient: WsClient
  private readonly localQueue: LocalQueue

  storeId: string
  storeName: string

  constructor(
    storeId: string,
    storeName: string,
    private readonly deps: StoreConnectionDeps
  ) {
    this.storeId = storeId
    this.storeName = storeName

    this.tokens = new TokenManager(async (refreshToken): Promise<ExchangeResult> => {
      return rawPostJson<ExchangeResult>(`${config.apiBaseUrl}/api/print-agent/token/exchange`, {
        refreshToken,
        agentInstallId: deps.device.agentInstallId,
        hostname: deps.device.hostname,
        agentVersion: deps.appVersion,
        os: process.platform
      })
    })

    const api = new ApiClient(this.tokens)
    this.endpoints = new PrintAgentEndpoints(api)

    const buffer = new TelemetryBuffer(deps.db, storeId, deps.adoptsLegacyRows)
    this.telemetry = new TelemetryService(api, buffer, deps.device, deps.appVersion)
    this.localQueue = new LocalQueue(deps.db, storeId, deps.adoptsLegacyRows)

    const scoped = deps.state.scopedFor(storeId)

    this.heartbeat = new Heartbeat({
      endpoints: this.endpoints,
      device: deps.device,
      telemetry: this.telemetry,
      appVersion: deps.appVersion,
      intervalMs: config.heartbeatIntervalMs
    })

    this.queueLoop = new QueueLoop({
      endpoints: this.endpoints,
      state: scoped,
      localQueue: this.localQueue,
      telemetry: this.telemetry,
      getPrinterConfig: deps.getPrinterConfig,
      withPrinter: deps.withPrinter,
      intervalMs: config.pollIntervalMs
    })

    this.wsClient = new WsClient({
      url: config.wsUrl,
      tokens: this.tokens,
      state: scoped,
      onJob: () => this.queueLoop.kick(),
      onConnected: () => {
        this.queueLoop.pause()
        this.queueLoop.kickFromReconnect()
      },
      onDisconnected: () => this.queueLoop.resume()
    })

    this.tokens.on('refresh-success', (info: { expiresInSec: number }) => {
      scoped.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `Sessão renovada (válida por ${Math.round(info.expiresInSec / 60)} min).`
      })
    })
    this.tokens.on('refresh-rejected', () => {
      // Token revogado no painel: esta loja para, as outras seguem.
      scoped.pushLog({
        time: formatLogTime(),
        level: 'error',
        message:
          'Token de conexão foi revogado pelo servidor. Gere um novo token no painel da loja e cole aqui.'
      })
      this.stop()
      deps.state.setStoreStatus(
        this.storeId,
        'red',
        'Sessão expirada — gere um novo token no painel.'
      )
    })
    this.tokens.on('refresh-failed', (err: Error) => {
      scoped.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `Falha ao renovar sessão: ${err.message}`
      })
    })
  }

  /** Troca o refresh token por um access token e descobre de qual loja ele é.
   *  Devolve o id/nome pra quem chamou persistir. */
  async authenticate(refreshToken: string): Promise<{ storeId: string; storeName: string }> {
    await this.tokens.setRefreshToken(refreshToken)
    await this.endpoints.ping({
      agentInstallId: this.deps.device.agentInstallId,
      hostname: this.deps.device.hostname,
      machineIdHash: this.deps.device.machineIdHash,
      agentVersion: this.deps.appVersion
    })
    const store = this.tokens.getStore()
    this.storeId = store?.id ?? this.storeId
    this.storeName = store?.name ?? this.storeName ?? 'Loja conectada'
    return { storeId: this.storeId, storeName: this.storeName }
  }

  async start(): Promise<void> {
    this.heartbeat.start()
    await this.queueLoop.start()
    this.wsClient.start()
  }

  stop(): void {
    this.queueLoop.stop()
    this.heartbeat.stop()
    this.wsClient.stop()
  }

  /** Suspensão do Windows: para tudo sem mexer no token. */
  suspend(): void {
    this.queueLoop.stop()
    this.wsClient.stop()
  }

  /** Pós-resume: reinicia loop e WS (ver comentário do scheduleRecovery). */
  async resumeAfterWake(): Promise<void> {
    this.queueLoop.stop()
    await this.queueLoop.start()
    this.wsClient.stop()
    this.wsClient.start()
  }

  getInFlightClaimId(): string | null {
    return this.queueLoop.getInFlightClaimId()
  }

  async releaseInFlight(): Promise<void> {
    const id = this.queueLoop.getInFlightClaimId()
    if (!id) return
    await this.endpoints.release(id, {
      errorCode: 'AGENT_QUIT',
      errorMessage: 'Agente encerrado antes de concluir a impressão.'
    })
  }

  async clearToken(): Promise<void> {
    await this.tokens.clear()
  }
}
