// Tipos compartilhados entre processos main, preload e renderer.
// Vai crescer conforme as etapas 3-7 (auth, queue, telemetry).

export type AgentStatus = 'green' | 'yellow' | 'red'

export type PrinterType = 'network' | 'windows_spooler'

export type PaperWidth = 58 | 80

// Modo de impressão ESCOLHIDO (persistido) — o que o agente manda no
// claim-lease e o servidor usa pra montar os bytes. Definido pelo wizard de
// teste guiado. Distinto do `PrintMode` derivado (badge da UI) lá embaixo.
//   escpos = Texto (ESC/POS CP850) | ascii = Simples (transliterado) | raster = Imagem (GS v 0)
export type PrintModeSelection = 'escpos' | 'ascii' | 'raster'

export type PrinterConfig = {
  type: PrinterType
  host?: string
  port?: number
  spoolerName?: string
  paperWidth: PaperWidth
  /** Modo escolhido no wizard de teste guiado. Mandado em todo claim-lease.
   *  Ausente = sem wizard ainda → o queueLoop deriva ('ascii' p/ Text-Only,
   *  senão 'escpos'). 'raster' só entra por escolha explícita do wizard. */
  printMode?: PrintModeSelection
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

/** v1.12.0: térmica que o Windows enxerga mas que ainda não tem impressora
 *  (fila) criada — Bluetooth pareada (porta COM de saída) ou USB sem driver
 *  (porta USB00x do usbprint). O app cria a fila «Generic / Text Only» nessa
 *  porta quando o lojista escolhe (`lib/printer/semFila.ts`). */
export type ImpressoraSemFila = {
  kind: 'bluetooth' | 'usb'
  /** COM3, USB001… */
  port: string
  /** Nome do aparelho Bluetooth ou descrição da porta USB. */
  label: string
  /** Linha de baixo na lista («Bluetooth · pareada (COM3)»). */
  detail: string
  /** Nome da fila que o app cria («Termica KPrinter_ab28»). */
  suggestedQueueName: string
  /** Fabricante USB (VID), quando é USB. 20D1 = Elgin. */
  vid: string | null
}

export type InstalarImpressoraResult =
  | { ok: true; queueName: string; elevated: boolean }
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
  /** v1.11.0: uma entrada por loja conectada nesta instalação. A impressora é
   *  compartilhada (é uma só, física); o que é por loja é a CONEXÃO.
   *  `connection` acima continua existindo e espelha a PRIMEIRA loja — é o que
   *  o gate de onboarding e a bandeja usam. */
  stores: StoreConnectionInfo[]
  version: string
}

export type StoreConnectionInfo = {
  storeId: string
  storeName: string
  /** Estado desta loja em particular (a bandeja mostra o pior de todas). */
  status: AgentStatus
  statusMessage: string
}
