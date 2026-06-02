import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// Singleton da conexão SQLite. better-sqlite3 é síncrono e single-threaded —
// suficiente pro volume do agente (≤ algumas dezenas de operações/min).
//
// Migrations declarativas, idempotentes. Crescer adicionando blocos novos no
// fim do `applySchema` — nunca alterar blocos antigos sem migração explícita.

const DB_FILENAME = 'agent.db'
// Sufixos do WAL/SHM que vivem ao lado do main DB.
const DB_RELATED_SUFFIXES = ['', '-wal', '-shm']

let dbInstance: Database.Database | null = null

function dbPath(): string {
  return join(app.getPath('userData'), DB_FILENAME)
}

export function openDb(): Database.Database {
  if (dbInstance) return dbInstance
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = dbPath()
  const db = new Database(path)
  // WAL melhora throughput pra reads concorrentes; NORMAL evita fsync por
  // commit (perda <1 transação em queda de energia — aceitável).
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  dbInstance = db
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

/**
 * Abre o DB com recovery automática contra corrupção.
 *
 * Cenário real: kill abrupto durante write deixa WAL/SHM em estado
 * inconsistente. better-sqlite3 falha em PRAGMA/CREATE com "file is not a
 * database" e propaga exception. Sem tratamento, o boot do main process
 * quebra silenciosamente.
 *
 * Estratégia: tenta abrir + roda `PRAGMA integrity_check`. Em qualquer
 * falha, renomeia os 3 arquivos (agent.db, .db-wal, .db-shm) pra
 * `.corrupt.<timestamp>` e tenta abrir fresco. Lojista perde histórico
 * de logs/telemetria persistidos, mas o app continua funcionando.
 *
 * Retorna meta `recovered: true` quando a recovery rolou, pra que o
 * main process possa logar isso visivelmente no histórico do lojista.
 */
export function openDbWithRecovery(): { db: Database.Database; recovered: boolean } {
  try {
    const db = openDb()
    const integrity = db.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      // Integridade ruim — força o caminho de recovery.
      closeDb()
      throw new Error(`integrity_check returned: ${integrity}`)
    }
    return { db, recovered: false }
  } catch (err) {
    // Falha na abertura ou na verificação. Limpa estado e renomeia.
    closeDb()
    quarantineCorruptDb(err)
    const db = openDb()
    return { db, recovered: true }
  }
}

function quarantineCorruptDb(reason: unknown): void {
  const dir = app.getPath('userData')
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/Z$/, '')
  for (const suffix of DB_RELATED_SUFFIXES) {
    const src = join(dir, DB_FILENAME + suffix)
    if (!existsSync(src)) continue
    const dst = `${src}.corrupt.${stamp}`
    try {
      renameSync(src, dst)
    } catch {
      // Se não conseguir renomear (lock, permissão), o openDb seguinte
      // vai falhar de novo — preferimos crashar com mensagem clara que
      // continuar com DB suspeito.
    }
  }
  console.warn('[db] DB corrompido detectado, arquivos movidos para .corrupt.*:', reason)
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claimed_items (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL,
      bytes_b64 TEXT NOT NULL,
      paper_width INTEGER NOT NULL,
      copies INTEGER NOT NULL DEFAULT 1,
      claimed_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    -- v1.5: text_data armazena o cupom ASCII pro modo compatibilidade.
    -- Migração inline (try/catch porque SQLite não tem ADD COLUMN IF NOT
    -- EXISTS). Em DBs já com a coluna, lança "duplicate column" e a gente
    -- engole. Em DBs novos, applySchema só roda o CREATE acima, então o
    -- ALTER é a única forma de adicionar sem dropar a tabela.

    CREATE TABLE IF NOT EXISTS telemetry_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_created_at
      ON telemetry_buffer(created_at);

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_ms INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_time_ms ON logs(time_ms);
  `)

  // Migrações idempotentes — cada ALTER pode lançar "duplicate column" se já
  // foi aplicada antes; engolimos o erro pra não impedir o boot.
  try {
    db.exec(`ALTER TABLE claimed_items ADD COLUMN text_data TEXT`)
  } catch {
    /* coluna já existe */
  }
  // bytes_b64 era NOT NULL no schema original. No modo compat o item só tem
  // text_data, então precisamos relaxar essa restrição. SQLite não suporta
  // ALTER COLUMN — mas como NOT NULL só rejeita NULL explícito no INSERT,
  // o workaround é gravar string vazia ("") em bytes_b64 quando a row é
  // text-only (ver LocalQueue.save). Sem migração de esquema.
}
