import { EventEmitter } from 'node:events'


export type ExchangeResult = {
  accessToken: string
  expiresIn: number // seconds
  store?: { id: string; name: string }
}

export type ExchangeFn = (refreshToken: string) => Promise<ExchangeResult>

/**
 * Eventos emitidos:
 *  - 'refresh-success' (info: {expiresInSec})  → access token renovado com sucesso
 *  - 'refresh-rejected' (err: Error)            → refresh token foi rejeitado pelo servidor (401)
 *                                                 → o agent não consegue se recuperar sozinho;
 *                                                   lojista precisa reauth manualmente
 *  - 'refresh-failed' (err: Error)              → falha de rede/server, não auth (retentável)
 */
export class TokenManager extends EventEmitter {
  private accessToken: string | null = null
  private expiresAt = 0
  private refreshPromise: Promise<string> | null = null
  private lastStore: ExchangeResult['store'] = undefined
  private refreshToken: string | null = null

  constructor(private readonly exchange: ExchangeFn) {
    super()
  }

  // ⚠️ v1.11.0: o refresh token vive em MEMÓRIA, não no safeStorage.
  // Antes cada TokenManager lia e escrevia a MESMA chave global
  // ('refresh_token'); com duas lojas, a segunda sobrescrevia a primeira e, no
  // refresh seguinte (~15min), as duas conexões passavam a usar o mesmo token —
  // dois loops claimando os pedidos da MESMA loja, e a outra parava de
  // imprimir. Quem persiste (a lista cifrada de lojas) é o `accountsStore`.
  async hasRefreshToken(): Promise<boolean> {
    return this.refreshToken !== null
  }

  async setRefreshToken(token: string): Promise<void> {
    this.refreshToken = token
    this.accessToken = null
    this.expiresAt = 0
  }

  async clear(): Promise<void> {
    this.accessToken = null
    this.expiresAt = 0
    this.lastStore = undefined
    this.refreshToken = null
  }

  invalidate(): void {
    this.accessToken = null
    this.expiresAt = 0
  }

  getStore(): ExchangeResult['store'] {
    return this.lastStore
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async doRefresh(): Promise<string> {
    const rt = this.refreshToken
    if (!rt) throw new Error('NOT_CONNECTED')
    try {
      const result = await this.exchange(rt)
      this.accessToken = result.accessToken
      this.expiresAt = Date.now() + result.expiresIn * 1000
      if (result.store) this.lastStore = result.store
      this.emit('refresh-success', { expiresInSec: result.expiresIn })
      return result.accessToken
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (isApiAuthError(e)) {
        this.emit('refresh-rejected', e)
      } else {
        this.emit('refresh-failed', e)
      }
      throw e
    }
  }
}


/**
 * Duck-type detect 401 vindo do rawPostJson/ApiError sem criar dep cycle
 * com src/lib/api/client.ts.
 */
function isApiAuthError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  return status === 401
}
