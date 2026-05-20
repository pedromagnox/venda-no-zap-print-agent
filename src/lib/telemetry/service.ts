import { version as osVersion } from 'node:os'
import type { ApiClient } from '@lib/api/client'
import type { TelemetryEvent } from '@lib/api/types'
import type { DeviceFingerprint } from '@lib/auth/device'
import type { TelemetryBuffer } from './buffer'
import { sanitize, sanitizeHost } from './sanitize'

// Builder + dispatcher de eventos de telemetria.
//
// Estratégia:
//  - Whitelist explícito de campos. Nada que o backend não conheça passa.
//  - Tenta enviar imediatamente. Em falha (offline, 5xx, auth), persiste
//    no SQLite via TelemetryBuffer e drena depois (Heartbeat chama drainBuffer).
//  - emit() é fire-and-forget — o caller não precisa await.
//  - Após N tentativas falhadas (10), descartamos o evento. Telemetria é
//    best-effort — não vamos guardar pra sempre algo que o servidor recusa.

const MAX_TELEMETRY_ATTEMPTS = 10

export type EmitInput = {
  type: TelemetryEvent['type']
  printerType?: TelemetryEvent['printerType']
  printerModel?: string
  printerVid?: number
  printerPid?: number
  printerHost?: string
  errorCode?: string
  errorMessage?: string
  durationMs?: number
}

export class TelemetryService {
  constructor(
    private readonly api: ApiClient,
    private readonly buffer: TelemetryBuffer,
    private readonly device: DeviceFingerprint,
    private readonly appVersion: string
  ) {}

  // Monta o payload completo, aplicando defaults e sanitização.
  build(input: EmitInput): TelemetryEvent {
    const event: TelemetryEvent = {
      type: input.type,
      agentInstallId: this.device.agentInstallId,
      agentVersion: this.appVersion,
      osVersion: safeOsVersion(),
      osBuild: this.device.osBuild,
      osLocale: this.device.osLocale,
      payloadVersion: 1
    }
    if (input.printerType !== undefined) event.printerType = input.printerType
    if (input.printerModel !== undefined) event.printerModel = sanitize(input.printerModel).slice(0, 80)
    if (input.printerVid !== undefined) event.printerVid = input.printerVid
    if (input.printerPid !== undefined) event.printerPid = input.printerPid
    if (input.printerHost !== undefined) event.printerHost = sanitizeHost(input.printerHost)
    if (input.errorCode !== undefined) event.errorCode = input.errorCode
    if (input.errorMessage !== undefined) event.errorMessage = sanitize(input.errorMessage).slice(0, 200)
    if (input.durationMs !== undefined) event.durationMs = Math.max(0, Math.round(input.durationMs))
    return event
  }

  emit(input: EmitInput): void {
    const event = this.build(input)
    void this.send(event).catch(() => {
      // Tudo que falhar é bufferado pra retry no próximo heartbeat.
      try {
        this.buffer.enqueue(event)
      } catch {
        // Buffer indisponível: desistimos silenciosamente — não há nada útil
        // a fazer e telemetria nunca deve quebrar o agente.
      }
    })
  }

  // Versão síncrona pra uso em crash handlers (process.on uncaughtException).
  // Não tenta enviar — só persiste no buffer. drainBuffer no próximo boot envia.
  enqueueSync(input: EmitInput): void {
    try {
      this.buffer.enqueue(this.build(input))
    } catch {
      /* swallow */
    }
  }

  private async send(event: TelemetryEvent): Promise<void> {
    await this.api.post('/api/print-agent/telemetry', event)
  }

  // Tenta esvaziar o buffer em batch. Para no primeiro erro pra não martelar.
  // Retorna estatísticas pra logging.
  async drainBuffer(maxItems = 50): Promise<{
    sent: number
    failed: number
    discarded: number
    remaining: number
  }> {
    const pending = this.buffer.pending(maxItems)
    let sent = 0
    let failed = 0
    let discarded = 0
    for (const item of pending) {
      // Limita o número de tentativas. Após 10 falhas, descartamos —
      // telemetria que o servidor não aceita há esse tempo não vai melhorar.
      if (item.attempts >= MAX_TELEMETRY_ATTEMPTS) {
        this.buffer.remove(item.id)
        discarded++
        continue
      }
      try {
        await this.send(item.event)
        this.buffer.remove(item.id)
        sent++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.buffer.markFailed(item.id, msg)
        failed++
        // Para no primeiro erro. Se for 5xx ou offline, o próximo tick tenta de novo.
        break
      }
    }
    return { sent, failed, discarded, remaining: this.buffer.count() }
  }
}

function safeOsVersion(): string | undefined {
  try {
    return osVersion()
  } catch {
    return undefined
  }
}
