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


// Snapshot completo do estado exposto ao renderer pelo main via IPC.
export type AgentSnapshot = {
  status: AgentStatus
  statusMessage: string
  lastActionAt: string | null
  printer: PrinterConfig
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
