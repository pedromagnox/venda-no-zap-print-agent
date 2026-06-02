import { config } from '../config'
import type { TokenManager } from '../auth/tokenManager'

// Timeout default pra qualquer request via ApiClient/rawPostJson.
// Servidor pendurar não pode travar o polling loop indefinidamente —
// melhor abortar e cair no backoff exponencial do queueLoop.
const DEFAULT_TIMEOUT_MS = 10_000

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string
  ) {
    super(`API ${status}: ${bodyText.slice(0, 200)}`)
    this.name = 'ApiError'
  }
}

/**
 * Cria um AbortController que aborta após `timeoutMs`.
 * Retorna o controller + cleanup pra limpar o timer ao final.
 */
function withTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  }
}

// Cliente HTTP enxuto sobre fetch. Bearer automático + retry único em 401.
// Retry em 401: invalida access, força refresh, e refaz a chamada. Se o refresh
// falhar, propaga o erro original.
export class ApiClient {
  constructor(
    private readonly tokens: TokenManager,
    private readonly baseUrl: string = config.apiBaseUrl
  ) {}

  async fetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const accessToken = await this.tokens.getAccessToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`
    const { signal, cleanup } = withTimeout(DEFAULT_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, { ...init, headers, signal })
    } catch (err) {
      throw enrichFetchError(err, url)
    } finally {
      cleanup()
    }
    if (res.status === 401 && !retried) {
      this.tokens.invalidate()
      return this.fetch(path, init, true)
    }
    return res
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.fetch(path)
    if (!res.ok) throw new ApiError(res.status, await safeText(res))
    return (await res.json()) as T
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(path, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new ApiError(res.status, await safeText(res))
    return (await res.json()) as T
  }

  async post(path: string, body?: unknown): Promise<void> {
    const init: RequestInit = { method: 'POST' }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await this.fetch(path, init)
    if (!res.ok) throw new ApiError(res.status, await safeText(res))
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

// Helper sem auth — usado pelo token exchange (a credencial é o próprio refresh).
export async function rawPostJson<T>(url: string, body: unknown): Promise<T> {
  const { signal, cleanup } = withTimeout(DEFAULT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    throw enrichFetchError(err, url)
  } finally {
    cleanup()
  }
  if (!res.ok) throw new ApiError(res.status, await safeText(res))
  return (await res.json()) as T
}

/**
 * O `fetch` do Node 20+ (undici) lança um erro genérico "fetch failed" quando
 * a request não completa, e enterra o motivo real em `err.cause`. Esta função
 * enriquece a `err.message` com o código de causa pra que apareça no log
 * do agente (ex: "fetch failed (ENOTFOUND)", "fetch failed (UND_ERR_CONNECT_TIMEOUT)",
 * "fetch failed (CERT_HAS_EXPIRED)", etc.).
 *
 * Códigos comuns:
 *  - ENOTFOUND, EAI_AGAIN       → DNS
 *  - ECONNREFUSED               → server porta fechada
 *  - ECONNRESET, EPIPE          → conexão dropada no meio
 *  - ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT → timeout no TCP/handshake
 *  - UND_ERR_HEADERS_TIMEOUT    → server não respondeu headers
 *  - UND_ERR_BODY_TIMEOUT       → response body travou
 *  - UND_ERR_SOCKET             → erro de socket genérico
 *  - CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE, etc → TLS
 *  - ERR_NETWORK_CHANGED        → rede mudou (Wi-Fi reconectou) mid-request
 */
function enrichFetchError(err: unknown, url: string): Error {
  if (!(err instanceof Error)) {
    return new Error(`fetch failed: ${String(err)} [${safeHost(url)}]`)
  }
  const cause = (err as Error & {
    cause?: { code?: string; errno?: number; syscall?: string; hostname?: string }
  }).cause
  const parts: string[] = []
  if (cause?.code) parts.push(cause.code)
  if (cause?.errno !== undefined && !cause.code) parts.push(`errno=${cause.errno}`)
  if (cause?.syscall) parts.push(cause.syscall)
  const detail = parts.length > 0 ? parts.join(' ') : null
  const host = safeHost(url)
  const suffix = detail ? ` (${detail} ${host})` : ` (${host})`
  // Evita acumular sufixo se a função for chamada >1x sobre o mesmo erro.
  if (err.message.includes('(') && err.message.endsWith(')')) {
    return err
  }
  // Erros do undici (native fetch do Node 18+) têm `message` como getter-only,
  // então `err.message = ...` lança TypeError "Cannot set property message of
  // which has only a getter". Criamos um novo Error preservando a cause e o
  // stack original. v1.5.0 e anteriores tinham mutação direta — bug visível
  // no log dos lojistas como "Cannot set property message of which has only
  // a getter" toda vez que o fetch falhava.
  const enriched = new Error(`${err.message}${suffix}`)
  ;(enriched as Error & { cause?: unknown }).cause = (err as Error & { cause?: unknown }).cause
  enriched.stack = err.stack
  return enriched
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown-host'
  }
}
