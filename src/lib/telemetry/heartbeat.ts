import type { PrintAgentEndpoints } from '@lib/api/endpoints'
import type { DeviceFingerprint } from '@lib/auth/device'
import type { TelemetryService } from './service'

// Heartbeat barato — chama /api/print-agent/ping pro backend saber que o agente
// está vivo. Atualiza apenas lastPrintAgentPingAt na loja (cheap).
// Aproveita cada tick pra drenar o buffer de telemetria acumulado quando offline.

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

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      await this.deps.endpoints.ping({
        agentInstallId: this.deps.device.agentInstallId,
        hostname: this.deps.device.hostname,
        machineIdHash: this.deps.device.machineIdHash,
        agentVersion: this.deps.appVersion
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
