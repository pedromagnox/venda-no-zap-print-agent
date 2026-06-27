import type Database from 'better-sqlite3'
import type { PaperWidth, PrintModeSelection } from '@shared/types'

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
  /** Legado: cupom em texto puro do modo compatibilidade antigo. Desde v1.10.4
   *  todos os modos vêm como bytes RAW, então fica sempre null em itens novos.
   *  Mantido só pra ler rows pendentes gravadas por versões anteriores. */
  text: string | null
  /** Modo (escpos/ascii/raster) com que o item foi claimado. Usado pra carimbar
   *  a telemetria no recoverLocal após crash/reboot. */
  printMode: PrintModeSelection | null
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
  text: string | null
  printMode: string | null
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
        (id, order_number, bytes_b64, text_data, print_mode, paper_width, copies, claimed_at, lease_expires_at, attempts, last_error)
      VALUES
        (@id, @orderNumber, @bytesB64, @text, @printMode, @paperWidth, @copies, @claimedAt, @leaseExpiresAt, 0, NULL)
    `)
    this.stmtDelete = db.prepare(`DELETE FROM claimed_items WHERE id = ?`)
    this.stmtList = db.prepare(`
      SELECT
        id, order_number AS orderNumber, bytes_b64 AS bytesB64,
        text_data AS text, print_mode AS printMode,
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

  /** Persiste um item já claimado pelo claim-lease (v1.10.4+) ANTES de imprimir
   *  (crash-safety). Sempre bytes RAW (text=null); guarda o printMode pro
   *  recoverLocal carimbar a telemetria certa após crash/reboot. */
  saveRow(row: ClaimedRow): void {
    this.stmtInsert.run({
      id: row.id,
      orderNumber: row.orderNumber,
      bytesB64: row.bytesB64,
      text: row.text,
      printMode: row.printMode,
      paperWidth: row.paperWidth,
      copies: row.copies,
      claimedAt: row.claimedAt,
      leaseExpiresAt: row.leaseExpiresAt
    })
  }

  remove(id: string): void {
    this.stmtDelete.run(id)
  }

  list(): ClaimedRow[] {
    const raw = this.stmtList.all() as RawRow[]
    return raw.map((r) => ({
      ...r,
      paperWidth: r.paperWidth === 58 ? 58 : 80,
      printMode: (r.printMode as PrintModeSelection | null) ?? null
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
