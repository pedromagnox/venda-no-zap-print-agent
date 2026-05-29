import type Database from 'better-sqlite3'
import type { LogEntry, LogLevel } from '@shared/types'
import { formatLogTime } from '@shared/logTime'

// Persistência de logs no SQLite — retenção 48h.
//
// Lifecycle:
//   - Boot: prune > 48h, recupera últimos N pra mostrar na UI.
//   - Cada pushLog → grava no SQLite + mantém em memória (cap 100 na UI).
//   - A cada 6h: prune novamente.

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000
const MESSAGE_MAX_CHARS = 2000

export class LogsStore {
  private readonly stmtInsert: Database.Statement
  private readonly stmtRecent: Database.Statement
  private readonly stmtPrune: Database.Statement
  private readonly stmtCount: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT INTO logs (time_ms, level, message) VALUES (?, ?, ?)`
    )
    this.stmtRecent = db.prepare(`
      SELECT time_ms AS timeMs, level, message
      FROM logs
      ORDER BY time_ms DESC
      LIMIT ?
    `)
    this.stmtPrune = db.prepare(`DELETE FROM logs WHERE time_ms < ?`)
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM logs`)
  }

  append(entry: LogEntry): void {
    const timeMs = entry.timeMs ?? Date.now()
    this.stmtInsert.run(timeMs, entry.level, entry.message.slice(0, MESSAGE_MAX_CHARS))
  }

  recent(limit = 100): LogEntry[] {
    const rows = this.stmtRecent.all(limit) as Array<{
      timeMs: number
      level: string
      message: string
    }>
    return rows.map((r) => ({
      timeMs: r.timeMs,
      time: formatLogTime(r.timeMs),
      level: r.level as LogLevel,
      message: r.message
    }))
  }

  pruneOlderThan(ageMs: number = FORTY_EIGHT_HOURS_MS): number {
    const cutoff = Date.now() - ageMs
    const result = this.stmtPrune.run(cutoff)
    return Number(result.changes)
  }

  count(): number {
    const row = this.stmtCount.get() as { c: number }
    return row.c
  }
}
