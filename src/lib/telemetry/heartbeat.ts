import type { PrintAgentEndpoints } from '@lib/api/endpoints'
import type { DeviceFingerprint } from '@lib/auth/device'
import type { TelemetryService } from './service'
import { collectHardwareInfo } from './hardware'

// Heartbeat barato — chama /api/print-agent/ping pro backend saber que o agente
// está vivo. Atualiza apenas lastPrintAgentPingAt na loja (cheap).
// Aproveita cada tick pra drenar o buffer de telemetria acumulado quando offline.
//
// v1.8.0: também envia inventário de hardware no ping, mas com cache 1h pra
// não rodar PowerShell em todo heartbeat (Get-CimInstance leva ~2-5s).

const HARDWARE_REFRESH_MS = 60 * 60 * 1000 // 1h

export type HeartbeatDeps = {
  endpoints: PrintAgentEndpoints
  device: DeviceFingerprint
  telemetry: TelemetryService
  appVersion: string
  intervalMs: number
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private cachedHardware: Record<string, unknown> | null = null
  private hardwareCachedAt = 0

  constructor(private readonly deps: HeartbeatDeps) {}

  isActive(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    // Tick imediato — buffer acumulado de eventos (agent_started, crash do boot anterior, etc.) sai cedo.
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async getHardwareInfo(): Promise<Record<string, unknown> | undefined> {
    const now = Date.now()
    if (this.cachedHardware && now - this.hardwareCachedAt < HARDWARE_REFRESH_MS) {
      return undefined // já enviado recentemente; não re-envia
    }
    try {
      const info = await collectHardwareInfo(this.deps.appVersion)
      this.cachedHardware = info as unknown as Record<string, unknown>
      this.hardwareCachedAt = now
      return this.cachedHardware
    } catch {
      return undefined
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const hardwareInfo = await this.getHardwareInfo()
      await this.deps.endpoints.ping({
        agentInstallId: this.deps.device.agentInstallId,
        hostname: this.deps.device.hostname,
        machineIdHash: this.deps.device.machineIdHash,
        agentVersion: this.deps.appVersion,
        ...(hardwareInfo ? { hardwareInfo } : {})
      })
      // Aproveita conexão verificada pra drenar buffer.
      await this.deps.telemetry.drainBuffer().catch(() => {})
    } catch {
      // Heartbeat é best-effort. Se cair, no próximo tick tenta de novo.
    } finally {
      this.inFlight = false
    }
  }
}
