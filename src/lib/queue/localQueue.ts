import type Database from 'better-sqlite3'
import type { ClaimResponse } from '@lib/api/types'
import type { PaperWidth } from '@shared/types'
import { normalizePaperWidth } from './paperWidth'

// Persistência de itens claimados-mas-não-impressos. Permite resumir
// impressão depois de crash sem perder pedidos pra fila do servidor.
//
// Lifecycle típico:
//   claim sucede → save() (antes de tentar print)
//   print + ack OK → remove()
//   print falha    → remove() + release no servidor
//   crash no meio  → boot seguinte chama list(), tenta imprimir cada um

export type ClaimedRow = {
  id: string
  orderNumber: string
  bytesB64: string
  paperWidth: PaperWidth
  copies: number
  claimedAt: number
  leaseExpiresAt: number | null
  attempts: number
  lastError: string | null
}

type RawRow = {
  id: string
  orderNumber: string
  bytesB64: string
  paperWidth: number
  copies: number
  claimedAt: number
  leaseExpiresAt: number | null
  attempts: number
  lastError: string | null
}

export class LocalQueue {
  private readonly stmtInsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtList: Database.Statement
  private readonly stmtIncrAttempts: Database.Statement
  private readonly stmtCount: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT OR REPLACE INTO claimed_items
        (id, order_number, bytes_b64, paper_width, copies, claimed_at, lease_expires_at, attempts, last_error)
      VALUES
        (@id, @orderNumber, @bytesB64, @paperWidth, @copies, @claimedAt, @leaseExpiresAt, 0, NULL)
    `)
    this.stmtDelete = db.prepare(`DELETE FROM claimed_items WHERE id = ?`)
    this.stmtList = db.prepare(`
      SELECT
        id, order_number AS orderNumber, bytes_b64 AS bytesB64,
        paper_width AS paperWidth, copies, claimed_at AS claimedAt,
        lease_expires_at AS leaseExpiresAt, attempts, last_error AS lastError
      FROM claimed_items
      ORDER BY claimed_at ASC
    `)
    this.stmtIncrAttempts = db.prepare(`
      UPDATE claimed_items SET attempts = attempts + 1, last_error = ? WHERE id = ?
    `)
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM claimed_items`)
  }

  save(claim: ClaimResponse): void {
    const leaseMs = Date.parse(claim.leaseExpiresAt)
    // Normaliza o paperWidth antes de gravar — o backend pode mandar
    // "80mm" (string) ou 80 (number). Coluna no SQLite é INTEGER, e o
    // list() compara com number literal — sem normalizar aqui, recovery
    // após crash com papel 58mm cai sempre em 80mm silenciosamente.
    const paperWidthNum = normalizePaperWidth(
      claim.payload.paperWidthMm ?? claim.payload.paperWidth
    )
    this.stmtInsert.run({
      id: claim.item.id,
      orderNumber: claim.item.orderNumber,
      bytesB64: claim.payload.bytes,
      paperWidth: paperWidthNum,
      copies: claim.payload.copies,
      claimedAt: Date.now(),
      leaseExpiresAt: Number.isFinite(leaseMs) ? leaseMs : null
    })
  }

  remove(id: string): void {
    this.stmtDelete.run(id)
  }

  list(): ClaimedRow[] {
    const raw = this.stmtList.all() as RawRow[]
    return raw.map((r) => ({
      ...r,
      paperWidth: r.paperWidth === 58 ? 58 : 80
    }))
  }

  markAttempt(id: string, error?: string): void {
    this.stmtIncrAttempts.run(error ?? null, id)
  }

  count(): number {
    const row = this.stmtCount.get() as { c: number }
    return row.c
  }
}
