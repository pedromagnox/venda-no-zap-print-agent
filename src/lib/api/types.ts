import type { PaperWidth, PrintModeSelection } from '@shared/types'

export type { PrintModeSelection }

export type QueueListItem = {
  id: string
  orderNumber: string
  createdAt?: string
}

export type QueueListResponse = {
  items: QueueListItem[]
}

// claim-lease (batch) — fonte única desde v1.10.4. Cada item já vem com os
// bytes ESC/POS prontos NO MODO pedido (escpos/ascii/raster), sempre RAW.
// NÃO traz `leaseExpiresAt` (lease é 2min server-side) nem `orderNumber`
// amigável (só `orderId`). Ver endpoints.normalizeLeaseItem.
export type LeaseItem = {
  id: string
  orderNumber: string
  reason?: string
  bytesB64: string // base64
  paperWidth?: PaperWidth | '58mm' | '80mm'
  paperWidthMm?: PaperWidth
}

export type ClaimLeaseResponse = {
  items: LeaseItem[]
}

// POST /api/print-queue/test-receipt — cupom-amostra renderizado no modo pedido
// (o raster só o servidor desenha). Usado pelo wizard de modo de impressão.
export type TestReceiptResult = {
  mode: PrintModeSelection
  paperWidth?: PaperWidth | '58mm' | '80mm'
  paperWidthMm?: PaperWidth
  bytesB64: string // base64
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
  /** v1.10.0: `reason` propaga do `print_queue.reason` do backend
   *  ('new_order', 'status:confirmado', 'manual_reprint', etc.). Usado pra
   *  carimbar a telemetria — distinguir 1ª impressão de reimpressão por
   *  mudança de status sem cruzar logs. Ausente em backends antigos. */
  item: { id: string; orderNumber: string; reason?: string }
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
  /** v1.10.4: modo de impressão usado no claim (escpos/ascii/raster). O
   *  servidor já registra `mode` no lease_claimed; aqui carimba os eventos de
   *  print pra correlacionar acerto/erro por modo. */
  printMode?: PrintModeSelection
  errorCode?: string
  errorMessage?: string
  durationMs?: number
  // v0.4.0: identificador do print_queue item (UUID). Permite correlacionar
  // o evento de telemetria com a row específica da fila + pedido. Vazio nos
  // testes manuais (botão "Imprimir teste") porque não tem queue item.
  queueId?: string
  /** v1.10.0: motivo da entrada na fila ('new_order', 'status:<novo>',
   *  'manual_reprint', etc.). Ecoa o `print_queue.reason` no backend.
   *  Permite distinguir 1ª impressão de reimpressão sem cruzar com queueId. */
  reason?: string
  payloadVersion: number
}

export type PingRequest = {
  agentInstallId: string
  hostname: string
  machineIdHash: string | null
  agentVersion: string
  /** v1.8.0: inventário sanitizado de hardware (OS, CPU, memória, display,
   *  rede, impressoras instaladas, USB devices). Backend salva em
   *  `print_agent_tokens.hardware_info`. Opcional pra retrocompat. */
  hardwareInfo?: Record<string, unknown>
}
