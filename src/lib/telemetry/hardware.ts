import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PS_TIMEOUT_MS = 15_000

// Inventário de hardware do PC do lojista. Coletado no boot e a cada N horas
// (cache em memória + cache server-side via hardware_info_updated_at).
// Usado em diagnóstico de suporte: quando o lojista envia log via auto-help,
// admin consulta `print_agent_tokens.hardware_info` filtrando por store_id e
// recupera contexto sem precisar pedir mais info pro lojista.
//
// Sanitização: NÃO coletamos MAC, IP completo, número de série, hostname
// completo (só os 2 primeiros chars). Coletamos: marca/modelo, especificações,
// plano de energia, impressoras instaladas, USB devices de impressora.

export interface HardwareInfo {
  collectedAt: string
  agent: {
    version: string
    nodeVersion: string
    electronRuntime: boolean
  }
  os: {
    platform: string
    arch: string
    release: string
    locale: string | null
    timezone: string | null
  }
  system: {
    manufacturer: string | null
    model: string | null
    family: string | null
    chassis: string | null
    biosVersion: string | null
  }
  cpu: {
    model: string | null
    logicalCores: number
    physicalCores: number | null
    speedMHz: number | null
  }
  memory: {
    totalMB: number
    freeMB: number
  }
  display: {
    primaryWidth: number | null
    primaryHeight: number | null
    monitorCount: number
  }
  network: Array<{
    name: string
    description: string
    linkSpeed: string | null
    mediaType: string | null
  }>
  power: {
    hasBattery: boolean
    batteryPercent: number | null
    activePlan: string | null
  }
  printers: Array<{
    name: string
    driver: string
    port: string
    status: string
  }>
  usbDevices: Array<{
    vid: string
    pid: string
    friendlyName: string
  }>
}

interface PSPayload {
  bios?: { Manufacturer?: string; SMBIOSBIOSVersion?: string }
  system?: { Manufacturer?: string; Model?: string; SystemFamily?: string; PCSystemType?: number }
  cpu?: { Name?: string; NumberOfLogicalProcessors?: number; NumberOfCores?: number; MaxClockSpeed?: number }
  battery?: Array<{ BatteryStatus?: number; EstimatedChargeRemaining?: number }>
  power?: string
  monitors?: Array<{ Name?: string; CurrentHorizontalResolution?: number; CurrentVerticalResolution?: number }>
  net?: Array<{ Name?: string; InterfaceDescription?: string; LinkSpeed?: string; MediaType?: string }>
  printers?: Array<{ Name?: string; DriverName?: string; PortName?: string; Status?: string }>
  usbPrinters?: Array<{ FriendlyName?: string; InstanceId?: string; Class?: string }>
}

// PCSystemType (Win32_ComputerSystem): 1=Desktop, 2=Mobile, 3=Workstation,
// 4=Enterprise Server, 5=SOHO Server, 6=Appliance PC, 7=Performance Server,
// 8=Maximum.
function chassisFromPCSystemType(t: number | undefined): string | null {
  switch (t) {
    case 1: return 'desktop'
    case 2: return 'laptop'
    case 3: return 'workstation'
    default: return t ? `type_${t}` : null
  }
}

function getSystemTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return null
  }
}

function tryParse(stdout: string): PSPayload | null {
  try {
    return JSON.parse(stdout) as PSPayload
  } catch {
    return null
  }
}

export async function collectHardwareInfo(agentVersion: string): Promise<HardwareInfo> {
  // Coleta básica via Node — funciona em qualquer plataforma.
  const cpus = os.cpus() ?? []
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const platform = os.platform()
  const arch = os.arch()
  const release = os.release()

  const base: HardwareInfo = {
    collectedAt: new Date().toISOString(),
    agent: {
      version: agentVersion,
      nodeVersion: process.versions.node ?? '',
      electronRuntime: !!process.versions['electron'],
    },
    os: {
      platform,
      arch,
      release,
      locale: getLocale(),
      timezone: getSystemTimezone(),
    },
    system: {
      manufacturer: null,
      model: null,
      family: null,
      chassis: null,
      biosVersion: null,
    },
    cpu: {
      model: cpus[0]?.model ?? null,
      logicalCores: cpus.length,
      physicalCores: null,
      speedMHz: cpus[0]?.speed ?? null,
    },
    memory: {
      totalMB: Math.round(totalMem / 1024 / 1024),
      freeMB: Math.round(freeMem / 1024 / 1024),
    },
    display: {
      primaryWidth: null,
      primaryHeight: null,
      monitorCount: 0,
    },
    network: [],
    power: {
      hasBattery: false,
      batteryPercent: null,
      activePlan: null,
    },
    printers: [],
    usbDevices: [],
  }

  // Windows-specific via PowerShell. Best-effort: se falha, retorna apenas
  // a parte coletada via Node (cpu, memória, OS).
  if (platform !== 'win32') return base

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    "$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1 Manufacturer, SMBIOSBIOSVersion;",
    "$system = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 Manufacturer, Model, SystemFamily, PCSystemType;",
    "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfLogicalProcessors, NumberOfCores, MaxClockSpeed;",
    "$battery = @(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining);",
    "$power = ((powercfg /getactivescheme) -replace '.*\\((.+)\\).*', '$1').Trim();",
    "$monitors = @(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object Name, CurrentHorizontalResolution, CurrentVerticalResolution);",
    "$net = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object Name, InterfaceDescription, @{N='LinkSpeed';E={$_.LinkSpeed}}, @{N='MediaType';E={$_.MediaType}});",
    "$printers = @(Get-Printer | Select-Object Name, DriverName, PortName, @{N='Status';E={$_.PrinterStatus.ToString()}});",
    "$usbPrinters = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_*' -and ($_.Class -eq 'Printer' -or $_.Class -eq 'USB' -or $_.FriendlyName -match 'print|POS|thermal|term') } | Select-Object FriendlyName, InstanceId, Class);",
    "[pscustomobject]@{ bios=$bios; system=$system; cpu=$cpu; battery=$battery; power=$power; monitors=$monitors; net=$net; printers=$printers; usbPrinters=$usbPrinters } | ConvertTo-Json -Depth 5 -Compress"
  ].join(' ')

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 512 }
    )
    const parsed = tryParse(stdout)
    if (!parsed) return base

    base.system.manufacturer = parsed.system?.Manufacturer ?? null
    base.system.model = parsed.system?.Model ?? null
    base.system.family = parsed.system?.SystemFamily ?? null
    base.system.chassis = chassisFromPCSystemType(parsed.system?.PCSystemType)
    base.system.biosVersion = parsed.bios?.SMBIOSBIOSVersion ?? null

    if (parsed.cpu) {
      base.cpu.model = parsed.cpu.Name ?? base.cpu.model
      base.cpu.logicalCores = parsed.cpu.NumberOfLogicalProcessors ?? base.cpu.logicalCores
      base.cpu.physicalCores = parsed.cpu.NumberOfCores ?? null
      base.cpu.speedMHz = parsed.cpu.MaxClockSpeed ?? base.cpu.speedMHz
    }

    const monitors = parsed.monitors ?? []
    base.display.monitorCount = monitors.length
    if (monitors[0]) {
      base.display.primaryWidth = monitors[0].CurrentHorizontalResolution ?? null
      base.display.primaryHeight = monitors[0].CurrentVerticalResolution ?? null
    }

    base.network = (parsed.net ?? []).map((n) => ({
      name: n.Name ?? '',
      description: n.InterfaceDescription ?? '',
      linkSpeed: n.LinkSpeed ?? null,
      mediaType: n.MediaType ?? null,
    }))

    const batteries = parsed.battery ?? []
    base.power.hasBattery = batteries.length > 0
    base.power.batteryPercent = batteries[0]?.EstimatedChargeRemaining ?? null
    base.power.activePlan = parsed.power ?? null

    base.printers = (parsed.printers ?? []).map((p) => ({
      name: p.Name ?? '',
      driver: p.DriverName ?? '',
      port: p.PortName ?? '',
      status: p.Status ?? '',
    }))

    base.usbDevices = (parsed.usbPrinters ?? [])
      .map((d) => {
        const m = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(d.InstanceId ?? '')
        if (!m) return null
        return {
          vid: m[1]!.toUpperCase(),
          pid: m[2]!.toUpperCase(),
          friendlyName: (d.FriendlyName ?? '').trim(),
        }
      })
      .filter((x): x is { vid: string; pid: string; friendlyName: string } => x !== null)
  } catch {
    // Best-effort — retorna o que conseguiu antes do erro PowerShell.
  }

  return base
}

function getLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return null
  }
}
