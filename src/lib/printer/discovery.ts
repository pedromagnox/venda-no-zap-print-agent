import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSpoolerModule } from './spoolerModule'

// Discovery de impressoras do Windows Spooler.
//
// Lista base via @thesusheer/electron-printer (sempre disponível) e ENRIQUECE
// com Get-Printer do PowerShell (status, porta). PowerShell é spawn-only quando
// listSpoolerPrinters é chamada — não é hot path.
//
// Se PowerShell falhar (timeout, permissão), retornamos a lista crua sem
// enrichment — best-effort, não bloqueia o app.

const PS_TIMEOUT_MS = 3000

const execFileAsync = promisify(execFile)

export type SpoolerStatus = 'normal' | 'error' | 'offline' | 'paper-out' | 'warning' | 'unknown'

export type DiscoveredSpoolerPrinter = {
  name: string
  isDefault: boolean
  status: SpoolerStatus
  portName: string | null
  /** LPT/COM detectado num PC moderno → 99% das vezes é setup errado de driver USB. */
  suspiciousPort: boolean
}

export async function listSpoolerPrinters(): Promise<DiscoveredSpoolerPrinter[]> {
  const mod = getSpoolerModule()
  const base = mod.getPrinters().map((p) => ({
    name: p.name,
    isDefault: !!p.isDefault
  }))

  const enriched = await loadWinPrinterDetails()

  return base
    .map((p) => {
      const detail = enriched.get(p.name)
      const portName = detail?.portName ?? null
      return {
        ...p,
        status: mapStatus(detail?.statusCode),
        portName,
        suspiciousPort: isSuspiciousPort(portName)
      }
    })
    .filter((p) => !isVirtualPrinter(p.name, p.portName))
}

// Heurística pra esconder "impressoras" virtuais que não fazem sentido pro
// caso de uso de impressão de pedidos: OneNote, Print to PDF, XPS, Fax,
// AnyDesk Printer, etc. Detectado pela porta canônica + keywords no nome.
// Se um dia precisar mostrar virtuais (caso de borda), basta expor um toggle
// no preferences e desligar este filtro condicionalmente.

const VIRTUAL_PORT_EXACT = new Set([
  'portprompt:', // Microsoft Print to PDF
  'nul:', // OneNote e similares
  'xpsport:', // Microsoft XPS Document Writer
  'shrfax:', // Windows Fax
  'file:' // print to file
])

const VIRTUAL_PORT_PREFIX = [
  'microsoft.office.onenote' // OneNote (Desktop, Protegido, etc)
]

const VIRTUAL_NAME_KEYWORDS = [
  'onenote',
  'microsoft print to pdf',
  'xps document writer',
  'send to ',
  'anydesk printer',
  'universal document converter',
  ' fax' // espaço antes pra evitar "Faxon" / "Faxonix" falsos positivos
]

function isVirtualPrinter(name: string, portName: string | null): boolean {
  const port = (portName ?? '').toLowerCase()
  if (VIRTUAL_PORT_EXACT.has(port)) return true
  if (VIRTUAL_PORT_PREFIX.some((p) => port.startsWith(p))) return true
  const lname = ` ${name.toLowerCase()} `
  return VIRTUAL_NAME_KEYWORDS.some((kw) => lname.includes(kw))
}

async function loadWinPrinterDetails(): Promise<
  Map<string, { statusCode: number; portName: string }>
> {
  const result = new Map<string, { statusCode: number; portName: string }>()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Printer | Select-Object Name, PortName, PrinterStatus | ConvertTo-Json -Depth 2 -Compress'
      ],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 256 }
    )
    if (!stdout.trim()) return result
    const parsed = JSON.parse(stdout) as unknown
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of arr) {
      if (row && typeof row === 'object') {
        const r = row as { Name?: string; PortName?: string; PrinterStatus?: number }
        if (typeof r.Name === 'string') {
          result.set(r.Name, {
            statusCode: typeof r.PrinterStatus === 'number' ? r.PrinterStatus : -1,
            portName: typeof r.PortName === 'string' ? r.PortName : ''
          })
        }
      }
    }
  } catch {
    /* swallow — degraded sem enrichment */
  }
  return result
}

// Códigos do MSFT_Printer.PrinterStatus (Win32). 0 = Normal; resto = problema.
function mapStatus(code: number | undefined): SpoolerStatus {
  if (code === undefined || code < 0) return 'unknown'
  if (code === 0) return 'normal'
  if (code === 2) return 'error'
  if (code === 5) return 'paper-out'
  if (code === 8) return 'offline'
  return 'warning'
}

function isSuspiciousPort(portName: string | null): boolean {
  if (!portName) return false
  // LPT (paralela) e COM (serial) num PC moderno são, na quase totalidade
  // dos casos, sinal de driver mapeado pra porta errada (impressora USB
  // que deveria estar em USB001/USB002).
  return /^(LPT|COM)\d+:?$/i.test(portName)
}
