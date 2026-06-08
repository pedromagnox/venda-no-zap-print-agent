// Tipos compartilhados entre processos main, preload e renderer.
// Vai crescer conforme as etapas 3-7 (auth, queue, telemetry).

export type AgentStatus = 'green' | 'yellow' | 'red'

export type PrinterType = 'network' | 'windows_spooler'

export type PaperWidth = 58 | 80

export type PrinterConfig = {
  type: PrinterType
  host?: string
  port?: number
  spoolerName?: string
  paperWidth: PaperWidth
}

export type HistoryEntry = {
  id: string
  orderNumber: string
  printedAt: string // ISO
  status: 'success' | 'failure'
}

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = {
  time: string // formatado por formatLogTime() -> "dd/mm hh:mm:ss"
  /** Epoch ms — preenchido automaticamente pelo state.pushLog. Usado pra retenção 48h. */
  timeMs?: number
  level: LogLevel
  message: string
}

export type Preferences = {
  autoStart: boolean
}

export type SpoolerStatus = 'normal' | 'error' | 'offline' | 'paper-out' | 'warning' | 'unknown'

export type SpoolerPrinterInfo = {
  name: string
  isDefault: boolean
  status: SpoolerStatus
  portName: string | null
  suspiciousPort: boolean
}

/** Térmica USB candidata a instalação automática como Generic / Text Only.
 *  Renderer trata 2 categorias:
 *    - `isKnown: true`  → VID está na whitelist (ex: YICHIP) → auto-instala
 *                         silenciosamente sem perguntar
 *    - `isKnown: false` → heurística (USB device + porta USB no spooler + sem
 *                         fila instalada) → mostra diálogo de confirmação
 *                         pra lojista decidir entre Generic ou instalar driver
 *                         do fabricante (Epson/Bematech/Daruma/Elgin) */
export type DetectedCheapPrinter = {
  vid: string
  pid: string
  vendor: string
  deviceName: string
  portName: string | null
  alreadyInstalled: boolean
  suggestedName: string
  isKnown: boolean
}

export type InstallResult =
  | { ok: true; printerName: string; portName: string }
  | { ok: false; error: string }


// Modo de impressão derivado do driver da impressora selecionada.
// `escpos`: caminho normal — driver real, agent manda bytes ESC/POS RAW.
// `compatibility`: driver é Generic/Text Only — agent pede ao backend cupom
// em texto puro ASCII e manda via spooler type='TEXT'. UI mostra badge.
export type PrintMode = 'escpos' | 'compatibility'

// Snapshot completo do estado exposto ao renderer pelo main via IPC.
export type AgentSnapshot = {
  status: AgentStatus
  statusMessage: string
  lastActionAt: string | null
  printer: PrinterConfig
  /** Modo derivado do driver atual. Re-detectado quando o lojista troca a
   *  impressora ou no boot do agente. Não persistido — sempre derivado. */
  printMode: PrintMode
  /** Nome do driver detectado (ex: "Generic / Text Only", "EPSON TM-T20").
   *  Null quando spooler enrichment falhou ou printer é rede TCP. Usado no
   *  UI pra explicar por que modo compatibilidade ativou. */
  printerDriver: string | null
  history: HistoryEntry[]
  logs: LogEntry[]
  preferences: Preferences
  connection: {
    connected: boolean
    storeName: string | null
    storeId: string | null
  }
  version: string
}
