import { PrinterError } from './types'

// Lazy-load do @thesusheer/electron-printer. Prebuilds APENAS pra win32 — em
// macOS/Linux a chamada falha com mensagem clara em vez de quebrar o app.
//
// Usa eval('require') pra escapar a análise estática do Vite. Sem isso o
// externalizeDepsPlugin coloca o require no topo do bundle, e a falha de
// load mata o main process inteiro antes da UI subir.

export type SpoolerPrinterInfo = {
  name: string
  isDefault: boolean
  options: Record<string, string>
}

export type SpoolerModule = {
  getPrinters: () => SpoolerPrinterInfo[]
  getPrinter: (name: string) => SpoolerPrinterInfo
  getDefaultPrinterName: () => string | undefined
  printDirect: (options: {
    data: Buffer | string
    printer: string
    type: 'RAW' | 'TEXT' | 'PDF' | 'JPEG' | 'POSTSCRIPT' | 'COMMAND' | 'AUTO'
    success?: (jobId: string) => void
    error?: (err: Error) => void
  }) => void
}

let cached: SpoolerModule | null = null
let cachedError: Error | null = null

function dynamicRequire(id: string): unknown {
  const req = eval('require') as (id: string) => unknown
  return req(id)
}

export function getSpoolerModule(): SpoolerModule {
  if (cached) return cached
  if (cachedError) throw makePrinterError(cachedError)
  try {
    cached = dynamicRequire('@thesusheer/electron-printer') as SpoolerModule
    return cached
  } catch (err) {
    cachedError = err instanceof Error ? err : new Error(String(err))
    throw makePrinterError(cachedError)
  }
}

export function spoolerAvailable(): boolean {
  if (cached) return true
  if (cachedError) return false
  try {
    getSpoolerModule()
    return true
  } catch {
    return false
  }
}

function makePrinterError(cause: Error): PrinterError {
  return new PrinterError(
    'DRIVER_MISSING',
    `driver do spooler indisponível (Windows-only): ${cause.message}`
  )
}
