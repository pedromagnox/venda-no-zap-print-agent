import type { PaperWidth } from '@shared/types'

export type QueueListItem = {
  id: string
  orderNumber: string
  createdAt?: string
}

export type QueueListResponse = {
  items: QueueListItem[]
}

// Backend v1.5+ devolve payload em uma das duas formas:
//   mode='escpos' → bytes (base64 ESC/POS pra impressora térmica real)
//   mode='ascii'  → text (string pra spooler type='TEXT', modo compatibilidade)
// Versões antigas do backend não retornam `mode` — caímos no shape `bytes`
// por default. Mantém retrocompat com servidores rodando payloadVersion=1.
export type ClaimPayload =
  | {
      mode?: 'escpos'
      bytes: string // base64
      paperWidth: PaperWidth | '58mm' | '80mm'
      paperWidthMm?: PaperWidth
      copies: number
    }
  | {
      mode: 'ascii'
      text: string
      paperWidth: PaperWidth | '58mm' | '80mm'
      paperWidthMm?: PaperWidth
      copies: number
    }

export type ClaimResponse = {
  item: { id: string; orderNumber: string }
  leaseExpiresAt: string // ISO
  payload: ClaimPayload
}

export type ClaimOpts = {
  /** Quando 'ascii', backend gera cupom em texto puro pra driver Generic/Text
   *  Only. Senão default 'escpos' (bytes binários). */
  mode?: 'escpos' | 'ascii'
  /** Override de largura — útil quando o agent sabe a largura real e o
   *  pdvSettings da loja aponta pra outro valor. Em mm: 58 ou 80. */
  paperWidth?: 58 | 80
}

export type ReleaseRequest = {
  errorCode: string
  errorMessage?: string
}

export type TelemetryEvent = {
  type:
    | 'agent_started'
    | 'agent_crashed'
    | 'print_attempt'
    | 'print_success'
    | 'print_failure'
    | 'printer_state_change'
  agentInstallId: string
  agentVersion: string
  osVersion?: string
  osBuild?: string
  osLocale?: string
  printerType?: 'network' | 'windows_spooler'
  printerModel?: string
  printerVid?: number
  printerPid?: number
  printerHost?: string
  errorCode?: string
  errorMessage?: string
  durationMs?: number
  // v0.4.0: identificador do print_queue item (UUID). Permite correlacionar
  // o evento de telemetria com a row específica da fila + pedido. Vazio nos
  // testes manuais (botão "Imprimir teste") porque não tem queue item.
  queueId?: string
  payloadVersion: number
}

export type PingRequest = {
  agentInstallId: string
  hostname: string
  machineIdHash: string | null
  agentVersion: string
}
