import { PrinterError, type Printer } from './types'
import { getSpoolerModule } from './spoolerModule'

// Driver de impressão via Windows Print Spooler.
//
// Usa @thesusheer/electron-printer (N-API, prebuilt win32-x64 no pacote).
// type 'RAW' garante que os bytes ESC/POS vão direto pro device sem o
// driver tentar "interpretar" como texto/PCL.
//
// O spooler é o caminho mais user-friendly no Windows: o lojista instala o
// driver do fabricante (que já vem com Bematech/Elgin/Daruma/Epson) e a
// impressora aparece em Painel de Controle > Dispositivos e Impressoras —
// sem precisar de Zadig/WinUSB.

const TIMEOUT_DEFAULT_MS = 15_000

export class WindowsSpoolerPrinter implements Printer {
  constructor(
    private readonly printerName: string,
    private readonly timeoutMs: number = TIMEOUT_DEFAULT_MS
  ) {}

  describe(): string {
    return `spooler://${this.printerName}`
  }

  async test(): Promise<void> {
    const mod = getSpoolerModule()
    try {
      const info = mod.getPrinter(this.printerName)
      if (!info || !info.name) {
        throw new PrinterError('DRIVER_MISSING', `impressora "${this.printerName}" não encontrada no spooler`)
      }
    } catch (err) {
      if (err instanceof PrinterError) throw err
      throw new PrinterError(
        'DRIVER_MISSING',
        `impressora "${this.printerName}" inacessível: ${errorMessage(err)}`
      )
    }
  }

  async print(bytes: Buffer): Promise<void> {
    const mod = getSpoolerModule()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(new PrinterError('TIMEOUT', `spooler não respondeu em ${this.timeoutMs}ms`))
        )
      }, this.timeoutMs)

      try {
        mod.printDirect({
          data: bytes,
          printer: this.printerName,
          type: 'RAW',
          success: () => finish(() => resolve()),
          error: (err) =>
            finish(() => reject(mapSpoolerError(err, this.printerName)))
        })
      } catch (syncErr) {
        finish(() =>
          reject(mapSpoolerError(toError(syncErr), this.printerName))
        )
      }
    })
  }

  async close(): Promise<void> {
    // Sem estado persistente entre prints (cada printDirect cria seu próprio job).
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function mapSpoolerError(err: Error, name: string): PrinterError {
  const msg = err.message ?? String(err)
  if (/access[\s_]*denied|0x0?5\b/i.test(msg)) {
    return new PrinterError('ACCESS_DENIED', `acesso negado em "${name}"`)
  }
  if (/not[\s_]*found|invalid[\s_]*printer|does not exist/i.test(msg)) {
    return new PrinterError('DRIVER_MISSING', `"${name}" não encontrada`)
  }
  if (/paper[\s_]*out|out of paper/i.test(msg)) {
    return new PrinterError('PAPER_OUT', `papel acabou em "${name}"`)
  }
  if (/offline|paused/i.test(msg)) {
    return new PrinterError('OFFLINE', `"${name}" offline ou pausada`)
  }
  return new PrinterError('IO_ERROR', msg)
}

