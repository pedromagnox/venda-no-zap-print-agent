import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Persistência simples de objetos JSON em userData/config/<key>.json.
// Não criptografa — usado pra dados não-sensíveis (printer config, preferências).
// Dados sensíveis (tokens) usam safeStorage.

const SUBDIR = 'config'

function fileFor(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(app.getPath('userData'), SUBDIR, `${safe}.json`)
}

export async function readJsonFile<T>(key: string, fallback: T): Promise<T> {
  const file = fileFor(key)
  if (!existsSync(file)) return fallback
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    // Arquivo corrompido — usa fallback e segue.
    return fallback
  }
}

/**
 * Escreve atomicamente — primeiro grava num .tmp, depois renomeia em cima do
 * arquivo final. Garante que o leitor nunca veja conteúdo parcial mesmo se
 * o processo crashar no meio da gravação. `rename` é atômico em todos os
 * filesystems suportados pelo Windows/Linux/macOS.
 */
export async function writeJsonFile(key: string, value: unknown): Promise<void> {
  const dir = join(app.getPath('userData'), SUBDIR)
  await mkdir(dir, { recursive: true })
  const finalPath = fileFor(key)
  const tmpPath = `${finalPath}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmpPath, finalPath)
  } catch (err) {
    // Tenta limpar o tmp se a gravação falhou no meio. Best-effort.
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}
