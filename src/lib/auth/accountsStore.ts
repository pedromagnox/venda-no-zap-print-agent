import { getSecure, setSecure, deleteSecure } from '@lib/storage/safeStorage'

// v1.11.0: uma instalação passa a atender VÁRIAS lojas (o lojista com duas
// lojas e uma impressora só). Antes existia um único `refresh_token` no
// safeStorage e colar o token da outra loja SUBSTITUÍA o primeiro.
//
// Agora guardamos uma lista cifrada. A chave antiga continua sendo lida uma
// única vez, na migração — quem atualiza do 1.10.x não precisa recolar nada.

const ACCOUNTS_KEY = 'accounts'
const LEGACY_KEY = 'refresh_token'

export type StoredAccount = {
  /** Vazio só no registro migrado do formato antigo, até o primeiro exchange
   *  dizer de qual loja aquele refresh token é. */
  storeId: string
  storeName: string
  refreshToken: string
}

function parse(raw: string | null): StoredAccount[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (a): a is StoredAccount =>
        !!a &&
        typeof (a as StoredAccount).refreshToken === 'string' &&
        (a as StoredAccount).refreshToken.length > 0
    )
  } catch {
    // Conteúdo corrompido: melhor pedir o token de novo do que travar o boot.
    return []
  }
}

/** Lista as lojas salvas. Migra o formato antigo (token único) na primeira vez. */
export async function loadAccounts(): Promise<StoredAccount[]> {
  const existing = parse(await getSecure(ACCOUNTS_KEY))
  if (existing.length > 0) return existing

  const legacy = await getSecure(LEGACY_KEY)
  if (!legacy) return []
  // storeId/storeName ficam vazios de propósito: quem preenche é o primeiro
  // exchange bem-sucedido, via upsertAccount().
  const migrated: StoredAccount[] = [{ storeId: '', storeName: '', refreshToken: legacy }]
  await saveAccounts(migrated)
  return migrated
}

export async function saveAccounts(list: StoredAccount[]): Promise<void> {
  await setSecure(ACCOUNTS_KEY, JSON.stringify(list))
}

/**
 * Insere ou atualiza uma loja. Identidade é o `storeId`; quando ele ainda não
 * é conhecido (registro migrado), casa pelo refresh token.
 *
 * Colar de novo o token de uma loja já conectada ATUALIZA aquela entrada em
 * vez de criar uma segunda — senão o mesmo pedido seria claimado duas vezes
 * pela mesma máquina.
 */
export async function upsertAccount(next: StoredAccount): Promise<StoredAccount[]> {
  const list = await loadAccounts()
  const idx = list.findIndex(
    (a) =>
      (next.storeId !== '' && a.storeId === next.storeId) || a.refreshToken === next.refreshToken
  )
  if (idx >= 0) list[idx] = next
  else list.push(next)
  await saveAccounts(list)
  // A chave antiga já foi absorvida pela lista — deixá-la pra trás faria a
  // migração rodar de novo e ressuscitar uma loja removida.
  await deleteSecure(LEGACY_KEY).catch(() => {})
  return list
}

export async function removeAccount(storeId: string): Promise<StoredAccount[]> {
  const list = (await loadAccounts()).filter((a) => a.storeId !== storeId)
  await saveAccounts(list)
  return list
}

export async function clearAccounts(): Promise<void> {
  await saveAccounts([])
  await deleteSecure(LEGACY_KEY).catch(() => {})
}
