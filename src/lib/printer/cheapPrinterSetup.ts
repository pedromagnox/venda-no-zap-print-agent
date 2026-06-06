import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedCheapPrinter, InstallResult } from '@shared/types'

const execFileAsync = promisify(execFile)
const PS_TIMEOUT_MS = 10_000

export type { DetectedCheapPrinter, InstallResult }

// VIDs USB de chips genéricos chineses usados em térmicas baratas (~R$ 90 no
// Mercado Livre / Shopee). Esses devices têm 3 problemas:
//   1) Windows reconhece como USB device mas não cria fila de impressão.
//   2) ROM da impressora não tem glyphs Latin-1+ — acento e símbolos não saem.
//   3) Não tem motor de corte físico — comando GS V cai no vazio.
//
// Workaround: instalar fila Generic / Text Only manualmente (`Add-Printer`),
// e marcar como modo compatibilidade (driver Generic → backend serve ASCII
// transliterado via [print-queue.ts mode='ascii']).
//
// VID 28E9 = YICHIP Semiconductor. Confirmado experimentalmente (jun/2026):
// implementa ESC/POS básico (bold, double-size, alignment, QR code) mas
// IGNORA codepage e CORTE. Mais VIDs cabem aqui conforme mapeamos no campo.
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

/** Normaliza um nome pra comparar entre FriendlyName e Description (espaços
 *  duplos, capitalização variável). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isUsbPort(portName: string | null | undefined): boolean {
  return !!portName && /^USB\d+$/i.test(portName)
}

// Enumera USB devices + portas + impressoras. Cruza pra retornar térmicas
// baratas detectadas e se já têm fila Windows.
export async function detectCheapUsbPrinters(): Promise<DetectedCheapPrinter[]> {
  let parsed: PSPayload
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
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 256 }
    )
    if (!stdout.trim()) return []
    parsed = JSON.parse(stdout) as PSPayload
  } catch {
    return []
  }

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
    if (!known) continue

    const friendly = (d.FriendlyName ?? '').trim()
    // Match porta pela Description (que costuma ser o FriendlyName do device).
    let portName: string | null = portByDescription.get(normalize(friendly)) ?? null
    // Fallback: prefixo do FriendlyName (ex: "YICHIP" bate com "YICHIP-Printer demo").
    if (!portName && friendly) {
      const prefix = normalize(friendly.split(/[\s-]/)[0] ?? '')
      for (const [desc, name] of portByDescription.entries()) {
        if (desc.startsWith(prefix)) {
          portName = name
          break
        }
      }
    }
    // Aceita só portas USBxxx — descarta WSD / IP / etc.
    if (!isUsbPort(portName)) portName = null

    result.push({
      vid,
      pid,
      vendor: known.vendor,
      deviceName: friendly,
      portName,
      alreadyInstalled: portName ? portsWithInstalledPrinter.has(portName) : false,
      suggestedName: friendly || known.defaultName
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
  // Sanitização defensiva — printerName/portName entram em comando PowerShell.
  // Aceitamos só letras/dígitos/underscore/hífen/espaço pra impedir injection.
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
    // Erros comuns:
    //  - "Acesso negado" / "elevation required": usuário não é admin
    //  - "driver not found": Generic / Text Only não está disponível (Windows N)
    //  - "port not found": porta sumiu (impressora desplugada entre detect e install)
    return { ok: false, error: msg.slice(0, 400) }
  }
}
