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

// v1.5.1: 3s era tight pra PCs lentos / com AV pesado. Get-Printer raramente
// passa de 1s num PC normal, mas PCs de loja muitas vezes ficam em swap, com
// Kaspersky/AVG interceptando syscalls. Aumentamos pra 10s — silenciosamente
// falhar e cair em escpos é pior que esperar 9s a mais no boot uma vez.
const PS_TIMEOUT_MS = 10_000

const execFileAsync = promisify(execFile)

export type SpoolerStatus = 'normal' | 'error' | 'offline' | 'paper-out' | 'warning' | 'unknown'

export type DiscoveredSpoolerPrinter = {
  name: string
  isDefault: boolean
  status: SpoolerStatus
  portName: string | null
  /** LPT/COM detectado num PC moderno → 99% das vezes é setup errado de driver USB. */
  suspiciousPort: boolean
  /** Driver Windows associado à impressora (ex: "Generic / Text Only",
   *  "EPSON TM-T20", "Bematech MP-4200 TH"). Null quando o enrichment do
   *  PowerShell falhou (timeout/permissão). */
  driverName: string | null
  /** True quando o driver não suporta ESC/POS direto e o agent deve usar
   *  modo compatibilidade (texto puro). Detectado via [isTextOnlyDriver]. */
  isTextOnlyDriver: boolean
}

// Drivers "burros" que aceitam texto mas não renderizam ESC/POS binário.
// v1.5.1: regra agressiva — QUALQUER driver com a palavra "Generic" no nome
// vira modo compat. No contexto do Print Agent (impressora térmica de pedido),
// se o lojista está usando driver "Generic" é porque o driver real do
// fabricante não está instalado — ESC/POS RAW vai sair como lixo binário de
// qualquer forma. Cobre "Generic / Text Only", "Generic Text", "Generic IBM
// Graphics 9pin", etc. "Text Only" isolado (sem "Generic") também cobrimos.
// Trade-off conhecido: "Generic PostScript Printer" cairia em compat e perder
// PS, mas PS num PC de delivery é praticamente inexistente.
const TEXT_ONLY_DRIVER_PATTERN = /\bgeneric\b|^text\s*only$/i

export function isTextOnlyDriver(driverName: string | null | undefined): boolean {
  if (!driverName) return false
  return TEXT_ONLY_DRIVER_PATTERN.test(driverName)
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
      const driverName = detail?.driverName ?? null
      return {
        ...p,
        status: mapStatus(detail?.statusCode),
        portName,
        suspiciousPort: isSuspiciousPort(portName),
        driverName,
        isTextOnlyDriver: isTextOnlyDriver(driverName)
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
  Map<string, { statusCode: number; portName: string; driverName: string }>
> {
  const result = new Map<string, { statusCode: number; portName: string; driverName: string }>()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Printer | Select-Object Name, PortName, PrinterStatus, DriverName | ConvertTo-Json -Depth 2 -Compress'
      ],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 256 }
    )
    if (!stdout.trim()) return result
    const parsed = JSON.parse(stdout) as unknown
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of arr) {
      if (row && typeof row === 'object') {
        const r = row as { Name?: string; PortName?: string; PrinterStatus?: number; DriverName?: string }
        if (typeof r.Name === 'string') {
          result.set(r.Name, {
            statusCode: typeof r.PrinterStatus === 'number' ? r.PrinterStatus : -1,
            portName: typeof r.PortName === 'string' ? r.PortName : '',
            driverName: typeof r.DriverName === 'string' ? r.DriverName : ''
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
