import { Mutex } from 'async-mutex'
import { randomUUID } from 'node:crypto'
import type { PrintAgentEndpoints } from '@lib/api/endpoints'
import { makePrinter, PrinterError, type PrinterErrorCode } from '@lib/printer'
import { sanitize } from '@lib/telemetry/sanitize'
import type { TelemetryService } from '@lib/telemetry/service'
import type { AgentState } from '@main/agentState'
import type { PrinterConfig, PrinterType } from '@shared/types'
import type { LocalQueue, ClaimedRow } from './localQueue'
import { normalizePaperWidth } from './paperWidth'

export type QueueLoopDeps = {
  endpoints: PrintAgentEndpoints
  state: AgentState
  localQueue: LocalQueue
  telemetry: TelemetryService
  getPrinterConfig: () => PrinterConfig
  intervalMs: number
  maxBackoffMs?: number
}

export class QueueLoop {
  private timeoutId: NodeJS.Timeout | null = null
  private active = false
  private consecutiveListErrors = 0
  private idleTicks = 0
  private readonly mutex = new Mutex()
  private readonly maxBackoffMs: number
  /** ID do item atualmente claimado (entre claim() e ack()/release()).
   *  Usado pelo before-quit pra fazer release best-effort e devolver o
   *  item pra fila do servidor mais rápido que esperar o lease expirar. */
  private inFlightClaimId: string | null = null

  /** Loga "polling normal" a cada N ticks consecutivos sem pedidos.
   *  Em 5s/tick (default), 120 ticks ≈ 10 min. */
  private static readonly IDLE_LOG_EVERY_N_TICKS = 120

  constructor(private readonly deps: QueueLoopDeps) {
    this.maxBackoffMs = deps.maxBackoffMs ?? 60_000
  }

  isActive(): boolean {
    return this.active
  }

  getInFlightClaimId(): string | null {
    return this.inFlightClaimId
  }

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.deps.state.pushLog({
      time: nowLogTime(),
      level: 'info',
      message: 'Polling da fila iniciado.'
    })
    await this.recoverLocal()
    this.schedule(0)
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    if (this.timeoutId) clearTimeout(this.timeoutId)
    this.timeoutId = null
    this.consecutiveListErrors = 0
    this.idleTicks = 0
    this.deps.state.pushLog({
      time: nowLogTime(),
      level: 'info',
      message: 'Polling da fila parado.'
    })
  }

  private async recoverLocal(): Promise<void> {
    const pending = this.deps.localQueue.list()
    if (pending.length === 0) return
    this.deps.state.pushLog({
      time: nowLogTime(),
      level: 'warn',
      message: `Recuperando ${pending.length} pedido(s) pendente(s) do banco local.`
    })
    for (const row of pending) {
      if (!this.active) break
      await this.mutex.runExclusive(() => this.printAndAck(row))
    }
  }

  private schedule(delayMs: number): void {
    if (!this.active) return
    this.timeoutId = setTimeout(() => {
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    if (!this.active) return
    try {
      const { items } = await this.deps.endpoints.listQueue()
      this.consecutiveListErrors = 0
      if (items.length > 0) {
        this.idleTicks = 0
        this.deps.state.pushLog({
          time: nowLogTime(),
          level: 'info',
          message: `Fila retornou ${items.length} pedido(s) — processando.`
        })
      } else {
        this.idleTicks++
        if (this.idleTicks > 0 && this.idleTicks % QueueLoop.IDLE_LOG_EVERY_N_TICKS === 0) {
          const minutes = Math.round((this.idleTicks * this.deps.intervalMs) / 60_000)
          this.deps.state.pushLog({
            time: nowLogTime(),
            level: 'info',
            message: `Polling normal — sem pedidos nos últimos ${minutes} min.`
          })
        }
      }
      for (const item of items) {
        if (!this.active) break
        await this.processOne(item.id, item.orderNumber)
      }
      this.schedule(this.deps.intervalMs)
    } catch (err) {
      this.consecutiveListErrors++
      const backoff = Math.min(
        this.maxBackoffMs,
        this.deps.intervalMs * 2 ** (this.consecutiveListErrors - 1)
      )
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.state.pushLog({
        time: nowLogTime(),
        level: 'warn',
        message: `Polling falhou (${this.consecutiveListErrors}): ${sanitize(msg)}. Retry em ${Math.round(backoff / 1000)}s.`
      })
      if (this.consecutiveListErrors >= 3) {
        this.deps.state.setStatus('red', 'Sem comunicação com o servidor.')
      }
      this.schedule(backoff)
    }
  }

  private async processOne(id: string, orderNumber: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      let claimedNumber = orderNumber
      try {
        const claim = await this.deps.endpoints.claim(id)
        claimedNumber = claim.item.orderNumber
        this.deps.localQueue.save(claim)
        this.inFlightClaimId = id
        try {
          await this.printAndAck({
            id,
            orderNumber: claimedNumber,
            bytesB64: claim.payload.bytes,
            paperWidth: normalizePaperWidth(
              claim.payload.paperWidthMm ?? claim.payload.paperWidth
            ),
            copies: claim.payload.copies,
            claimedAt: Date.now(),
            leaseExpiresAt: Date.parse(claim.leaseExpiresAt) || null,
            attempts: 0,
            lastError: null
          })
        } finally {
          this.inFlightClaimId = null
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.deps.state.pushLog({
          time: nowLogTime(),
          level: 'warn',
          message: `Claim falhou pra #${claimedNumber}: ${sanitize(msg)}`
        })
      }
    })
  }

  /**
   * Tenta soltar o item atualmente claimado de volta na fila do servidor.
   * Usado no before-quit pra não deixar o item refém do lease (que só expira
   * minutos depois). Best-effort: se a request demorar mais que `timeoutMs`,
   * abandonamos — o lease vai expirar no servidor e o item volta pra fila.
   */
  async releaseInFlightBestEffort(timeoutMs: number): Promise<void> {
    const id = this.inFlightClaimId
    if (!id) return
    const releasePromise = this.deps.endpoints
      .release(id, {
        errorCode: 'AGENT_SHUTDOWN',
        errorMessage: 'Agent shutting down'
      })
      .catch(() => {
        /* best-effort, swallow */
      })
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.race([releasePromise, timeoutPromise])
  }

  private async printAndAck(row: ClaimedRow): Promise<void> {
    const startedAt = Date.now()
    const { id, orderNumber } = row
    const printerConfig = this.deps.getPrinterConfig()
    this.deps.telemetry.emit({
      type: 'print_attempt',
      queueId: id,
      ...this.printerContext(printerConfig)
    })
    try {
      const bytes = Buffer.from(row.bytesB64, 'base64')
      const printer = makePrinter(printerConfig)
      try {
        await printer.print(bytes)
      } finally {
        await printer.close()
      }
      try {
        await this.deps.endpoints.ack(id)
      } catch (ackErr) {
        const msg = ackErr instanceof Error ? ackErr.message : String(ackErr)
        this.deps.state.pushLog({
          time: nowLogTime(),
          level: 'warn',
          message: `Ack pro #${orderNumber} falhou após print bem-sucedido: ${sanitize(msg)}`
        })
      }
      this.deps.localQueue.remove(id)
      const durationMs = Date.now() - startedAt
      this.deps.state.pushHistory({
        id,
        orderNumber,
        printedAt: new Date().toISOString(),
        status: 'success'
      })
      this.deps.state.pushLog({
        time: nowLogTime(),
        level: 'info',
        message: `Pedido #${orderNumber} impresso (${durationMs}ms)`
      })
      this.deps.state.setStatus('green', `Último: pedido #${orderNumber} impresso.`)
      this.deps.telemetry.emit({
        type: 'print_success',
        queueId: id,
        durationMs,
        ...this.printerContext(printerConfig)
      })
    } catch (err) {
      const code: PrinterErrorCode | 'API_ERROR' =
        err instanceof PrinterError ? err.code : 'API_ERROR'
      const rawMsg = err instanceof Error ? err.message : String(err)
      const errorMessage = sanitize(rawMsg).slice(0, 200)
      this.deps.localQueue.markAttempt(id, errorMessage)

      try {
        await this.deps.endpoints.release(id, { errorCode: code, errorMessage })
      } catch (releaseErr) {
        const rm = releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        this.deps.state.pushLog({
          time: nowLogTime(),
          level: 'warn',
          message: `Release falhou pra #${orderNumber}: ${sanitize(rm)}`
        })
      }
      this.deps.localQueue.remove(id)

      this.deps.state.pushHistory({
        id: `${id}_${randomUUID().slice(0, 4)}`,
        orderNumber,
        printedAt: new Date().toISOString(),
        status: 'failure'
      })
      this.deps.state.pushLog({
        time: nowLogTime(),
        level: 'error',
        message: `Pedido #${orderNumber} falhou (${code}): ${errorMessage}`
      })
      this.deps.state.setStatus('red', `Falha ao imprimir #${orderNumber} (${code}).`)
      this.deps.telemetry.emit({
        type: 'print_failure',
        queueId: id,
        durationMs: Date.now() - startedAt,
        errorCode: code,
        errorMessage,
        ...this.printerContext(printerConfig)
      })
    }
  }

  private printerContext(config: PrinterConfig): {
    printerType: PrinterType
    printerHost?: string
  } {
    if (config.type === 'network' && config.host) {
      return { printerType: 'network', printerHost: config.host }
    }
    // v0.4.0: spooler também envia o nome da impressora como printerHost
    // pra ficar visível no admin (ex: "G250", "POS58", "EPSON TM-T20").
    if (config.type === 'windows_spooler' && config.spoolerName) {
      return { printerType: 'windows_spooler', printerHost: config.spoolerName }
    }
    return { printerType: config.type }
  }
}

function nowLogTime(): string {
  return new Date().toLocaleTimeString('pt-BR')
}
