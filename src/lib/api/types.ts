import type { PaperWidth } from '@shared/types'

export type QueueListItem = {
  id: string
  orderNumber: string
  createdAt?: string
}

export type QueueListResponse = {
  items: QueueListItem[]
}

export type ClaimResponse = {
  item: { id: string; orderNumber: string }
  leaseExpiresAt: string // ISO
  payload: {
    bytes: string // base64
    // Backend manda paperWidth como "58mm"|"80mm" (string, legacy do PWA) e
    // paperWidthMm como number. Preferimos paperWidthMm; o tipo string aqui
    // existe só pra documentar o que vem na wire.
    paperWidth: PaperWidth | '58mm' | '80mm'
    paperWidthMm?: PaperWidth
    copies: number
  }
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
