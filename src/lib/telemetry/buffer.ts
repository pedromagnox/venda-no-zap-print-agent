import type Database from 'better-sqlite3'
import type { TelemetryEvent } from '@lib/api/types'

// Buffer pra eventos de telemetria quando o backend está offline.
// Retenção 7 dias (pruneOlderThan).

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export type BufferedEvent = {
  id: number
  event: TelemetryEvent
  createdAt: number
  attempts: number
  lastError: string | null
}

export class TelemetryBuffer {
  private readonly stmtInsert: Database.Statement
  private readonly stmtPending: Database.Statement
  private readonly stmtRemove: Database.Statement
  private readonly stmtMarkFailed: Database.Statement
  private readonly stmtPrune: Database.Statement
  private readonly stmtCount: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO telemetry_buffer (payload, created_at, attempts) VALUES (?, ?, 0)
    `)
    this.stmtPending = db.prepare(`
      SELECT id, payload, created_at AS createdAt, attempts, last_error AS lastError
      FROM telemetry_buffer
      ORDER BY created_at ASC
      LIMIT ?
    `)
    this.stmtRemove = db.prepare(`DELETE FROM telemetry_buffer WHERE id = ?`)
    this.stmtMarkFailed = db.prepare(`
      UPDATE telemetry_buffer SET attempts = attempts + 1, last_error = ? WHERE id = ?
    `)
    this.stmtPrune = db.prepare(`DELETE FROM telemetry_buffer WHERE created_at < ?`)
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM telemetry_buffer`)
  }

  enqueue(event: TelemetryEvent): void {
    this.stmtInsert.run(JSON.stringify(event), Date.now())
  }

  pending(limit = 50): BufferedEvent[] {
    const rows = this.stmtPending.all(limit) as Array<{
      id: number
      payload: string
      createdAt: number
      attempts: number
      lastError: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      event: JSON.parse(r.payload) as TelemetryEvent,
      createdAt: r.createdAt,
      attempts: r.attempts,
      lastError: r.lastError
    }))
  }

  remove(id: number): void {
    this.stmtRemove.run(id)
  }

  markFailed(id: number, error: string): void {
    this.stmtMarkFailed.run(error.slice(0, 500), id)
  }

  pruneOlderThan(ageMs: number = SEVEN_DAYS_MS): number {
    const result = this.stmtPrune.run(Date.now() - ageMs)
    return Number(result.changes)
  }

  count(): number {
    const row = this.stmtCount.get() as { c: number }
    return row.c
  }
}
