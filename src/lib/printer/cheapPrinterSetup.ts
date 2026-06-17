import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedCheapPrinter, InstallResult } from '@shared/types'

const execFileAsync = promisify(execFile)
const PS_TIMEOUT_MS = 10_000

export type { DetectedCheapPrinter, InstallResult }

// VIDs USB de chips genéricos chineses cuja ROM não tem glyphs Latin-1 —
// acento sai como lixo em qualquer codepage ESC/POS. Pra essas, callers usam
// `formatReceiptBytes(..., asciiOnly=true)`. KNOWN aqui significa "auto-instalar
// silenciosamente sem perguntar nada ao lojista" (whitelist segura, confirmada
// experimentalmente).
//
// VID 28E9 = YICHIP Semiconductor — confirmado jun/2026. ESC/POS básico
// funciona (bold, double-size, alignment, QR code) mas ignora codepage e
// comando de corte.
const KNOWN_VIDS: Record<string, { vendor: string; defaultName: string }> = {
  '28E9': { vendor: 'YICHIP', defaultName: 'Impressora Termica USB' }
}

interface PSDevice { FriendlyName?: string; InstanceId?: string }
interface PSPort { Name?: string; Description?: string }
interface PSPrinter { Name?: string; PortName?: string; DriverName?: string }

interface PSPayload {
  devices?: PSDevice[]
  printerPorts?: PSPort[]
  printers?: PSPrinter[]
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isUsbPort(portName: string | null | undefined): boolean {
  return !!portName && /^USB\d+$/i.test(portName)
}

// Enumera USB devices + portas + impressoras. Cruza pra retornar TODOS os
// candidatos a instalação automática:
//   - VID conhecido (KNOWN_VIDS) → `isKnown: true` → UI auto-instala sem perguntar
//   - VID não conhecido + porta USB criada pelo Windows + sem fila → `isKnown: false`
//     → UI mostra diálogo de confirmação (lojista decide se quer Generic/Text Only
//     ou se vai instalar driver do fabricante)
//
// A heurística "porta USB existente no spooler" é o que separa "USB device
// qualquer" de "impressora térmica genérica". Windows só cria USB00X
// automaticamente pra devices que declaram USB Printer Class (subclass 7).
// Mouse/teclado/webcam não viram USB00X.
// Em máquina sob pressão de memória (POS Celeron em swap), o spawn do
// powershell.exe às vezes estoura o timeout ou falha no primeiro try, e a
// detecção volta vazia — indistinguível de "não tem térmica". Como isto roda
// em background (não bloqueia a UI), retentamos com timeout crescente.
// SÓ retenta em FALHA (throw / stdout vazio); um JSON válido com lista vazia é
// o caso normal (máquina sem térmica barata) e retorna na hora, sem penalizar
// quem não tem o device.
const PS_DETECT_ATTEMPTS = 3
const PS_DETECT_BACKOFF_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runDetectProbe(timeoutMs: number): Promise<PSPayload | null> {
  try {
    const script =
      "$d = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.InstanceId -like 'USB\\VID_*' } | Select-Object FriendlyName, InstanceId);" +
      "$p = @(Get-PrinterPort -ErrorAction SilentlyContinue | Select-Object Name, Description);" +
      "$pr = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, PortName, DriverName);" +
      "[pscustomobject]@{ devices = $d; printerPorts = $p; printers = $pr } | ConvertTo-Json -Depth 5 -Compress"

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 256 }
    )
    if (!stdout.trim()) return null // sem saída = sonda falhou → caller retenta
    return JSON.parse(stdout) as PSPayload
  } catch {
    return null
  }
}

export async function detectCheapUsbPrinters(): Promise<DetectedCheapPrinter[]> {
  let parsed: PSPayload | null = null
  for (let attempt = 0; attempt < PS_DETECT_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(PS_DETECT_BACKOFF_MS * attempt)
    // timeout crescente: 10s, 15s, 20s
    parsed = await runDetectProbe(PS_TIMEOUT_MS + attempt * 5_000)
    if (parsed) break
  }
  if (!parsed) return []

  const devices = parsed.devices ?? []
  const ports = parsed.printerPorts ?? []
  const printers = parsed.printers ?? []

  const portByDescription = new Map<string, string>()
  for (const p of ports) {
    if (p.Name && p.Description) {
      portByDescription.set(normalize(p.Description), p.Name)
    }
  }
  const portsWithInstalledPrinter = new Set(
    printers.map((p) => p.PortName).filter((n): n is string => !!n)
  )

  const result: DetectedCheapPrinter[] = []
  for (const d of devices) {
    const m = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(d.InstanceId ?? '')
    if (!m) continue
    const vid = m[1]!.toUpperCase()
    const pid = m[2]!.toUpperCase()
    const known = KNOWN_VIDS[vid]
    const isKnown = !!known

    const friendly = (d.FriendlyName ?? '').trim()
    let portName: string | null = portByDescription.get(normalize(friendly)) ?? null
    if (!portName && friendly) {
      const prefix = normalize(friendly.split(/[\s-]/)[0] ?? '')
      for (const [desc, name] of portByDescription.entries()) {
        if (desc.startsWith(prefix)) {
          portName = name
          break
        }
      }
    }
    if (!isUsbPort(portName)) portName = null

    // Pra VID desconhecido, exigimos porta USB. Sem porta = device USB que
    // não é impressora (mouse, teclado, etc) — descarta.
    if (!isKnown && !portName) continue

    result.push({
      vid,
      pid,
      vendor: known?.vendor ?? 'Desconhecido',
      deviceName: friendly,
      portName,
      alreadyInstalled: portName ? portsWithInstalledPrinter.has(portName) : false,
      suggestedName: friendly || known?.defaultName || 'Impressora USB',
      isKnown
    })
  }
  return result
}

/** Cria uma fila de impressão Windows com driver Generic / Text Only apontando
 *  pra `portName`. Idempotente: se já existe impressora com o mesmo nome,
 *  retorna ok sem fazer nada. */
export async function installCheapPrinter(args: {
  printerName: string
  portName: string
}): Promise<InstallResult> {
  const printerName = args.printerName.trim()
  const portName = args.portName.trim()
  if (!printerName || !portName) {
    return { ok: false, error: 'Nome ou porta inválidos.' }
  }
  if (!isUsbPort(portName)) {
    return { ok: false, error: `Porta "${portName}" não parece USB (USB001, USB002...).` }
  }
  if (!/^[A-Za-z0-9 _\-]+$/.test(printerName) || !/^USB\d+$/i.test(portName)) {
    return { ok: false, error: 'Caracteres inválidos no nome ou porta.' }
  }
  try {
    const script =
      `$ErrorActionPreference = 'Stop';` +
      `$existing = Get-Printer -Name '${printerName}' -ErrorAction SilentlyContinue;` +
      `if ($existing) { Write-Output 'EXISTING'; exit 0 }` +
      `Add-Printer -Name '${printerName}' -DriverName 'Generic / Text Only' -PortName '${portName}';` +
      `Write-Output 'CREATED'`

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 16 }
    )
    const tag = stdout.trim()
    if (tag === 'CREATED' || tag === 'EXISTING') {
      return { ok: true, printerName, portName }
    }
    return { ok: false, error: `Resposta inesperada do PowerShell: ${tag.slice(0, 200)}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.slice(0, 400) }
  }
}
