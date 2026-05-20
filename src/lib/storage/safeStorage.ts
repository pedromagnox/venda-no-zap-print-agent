import { app, safeStorage } from 'electron'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Wrapper sobre o safeStorage do Electron (DPAPI no Windows).
// Armazena strings criptografadas em arquivos individuais sob userData/secure/.
// Sem dependência nativa (keytar). Em caso de safeStorage indisponível, falha
// pra modo dev (texto plano) com warning explícito.

const SECURE_DIR_NAME = 'secure'

function dir(): string {
  return join(app.getPath('userData'), SECURE_DIR_NAME)
}

function fileFor(key: string): string {
  // Sanitiza key pra evitar path traversal por engano.
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(dir(), `${safe}.bin`)
}

export async function setSecure(key: string, value: string): Promise<void> {
  await mkdir(dir(), { recursive: true })
  const file = fileFor(key)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value)
    await writeFile(file, encrypted)
  } else {
    // Fallback dev — Linux sem keyring, etc. Não deve acontecer em Win/macOS.
    console.warn(`[safeStorage] encryption unavailable, storing "${key}" as plaintext`)
    await writeFile(file, value, 'utf8')
  }
}

export async function getSecure(key: string): Promise<string | null> {
  const file = fileFor(key)
  if (!existsSync(file)) return null
  const buf = await readFile(file)
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buf)
    } catch {
      // Buffer corrompido ou chave do OS rotacionada — trata como ausente.
      return null
    }
  }
  return buf.toString('utf8')
}

export async function deleteSecure(key: string): Promise<void> {
  const file = fileFor(key)
  if (existsSync(file)) {
    await unlink(file)
  }
}
