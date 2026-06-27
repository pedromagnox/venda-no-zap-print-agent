// Mock backend isolado pra testes locais — implementa todos os endpoints
// que o agente consome com estado em memória. Sem deps extras (http nativo).
// Ativado via PRINT_AGENT_USE_MOCK=true (default em dev). Em produção: desligado.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

type QueueItem = {
  id: string
  orderNumber: string
  status: 'pending' | 'leased'
  leasedUntil?: number
  payload: {
    bytes: string // base64
    paperWidth: 58 | 80
    copies: number
  }
}

type SeedOptions = {
  id?: string
  orderNumber?: string
  paperWidth?: 58 | 80
  copies?: number
  bodyText?: string
}

export type MockHandle = {
  port: number
  stop: () => Promise<void>
  seedJob: (opts?: SeedOptions) => string
  state: () => { queue: QueueItem[]; issuedTokens: number }
}

const ACCESS_TOKEN_PREFIX = 'mock_at_'

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status
  if (body === undefined) {
    res.end()
  } else {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += String(chunk)
    })
    req.on('end', () => {
      if (!buf) return resolve({})
      try {
        const parsed = JSON.parse(buf) as unknown
        if (typeof parsed === 'object' && parsed !== null) {
          resolve(parsed as Record<string, unknown>)
        } else {
          resolve({})
        }
      } catch (e) {
        reject(e instanceof Error ? e : new Error('parse error'))
      }
    })
    req.on('error', reject)
  })
}

function bearer(req: IncomingMessage): string | null {
  const auth = req.headers['authorization']
  if (!auth || Array.isArray(auth)) return null
  const m = auth.match(/^Bearer (.+)$/)
  return m && m[1] ? m[1] : null
}

export function startMockBackend(port: number): Promise<MockHandle> {
  const queue: QueueItem[] = []
  const issuedAccessTokens = new Map<string, number>() // token → expiresAt ms

  const isValidAccess = (token: string | null): boolean => {
    if (!token) return false
    const exp = issuedAccessTokens.get(token)
    return exp !== undefined && Date.now() < exp
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'

    // Health / debug
    if (path === '/__mock/health' && method === 'GET') {
      return send(res, 200, { ok: true, queue: queue.length })
    }

    // Token exchange (público — refresh é a credencial)
    if (path === '/api/print-agent/token/exchange' && method === 'POST') {
      const body = await readJson(req).catch((): Record<string, unknown> => ({}))
      const rt = body['refreshToken']
      if (typeof rt !== 'string' || rt.length < 4) {
        return send(res, 400, { error: 'INVALID_REFRESH_TOKEN' })
      }
      const accessToken = ACCESS_TOKEN_PREFIX + randomUUID()
      const expiresIn = 900 // 15 min
      issuedAccessTokens.set(accessToken, Date.now() + expiresIn * 1000)
      return send(res, 200, {
        accessToken,
        expiresIn,
        store: { id: 'mock-store-1', name: 'Loja Mock — Venda no Zap' }
      })
    }

    // Endpoints autenticados
    const token = bearer(req)
    if (!isValidAccess(token)) {
      return send(res, 401, { error: 'UNAUTHENTICATED' })
    }

    if (path === '/api/print-queue' && method === 'GET') {
      // Limpa leases expirados antes de listar.
      const now = Date.now()
      for (const item of queue) {
        if (item.status === 'leased' && item.leasedUntil !== undefined && item.leasedUntil < now) {
          item.status = 'pending'
          delete item.leasedUntil
        }
      }
      const items = queue
        .filter((q) => q.status === 'pending')
        .map((q) => ({ id: q.id, orderNumber: q.orderNumber }))
      return send(res, 200, { items })
    }

    // claim-lease (batch) — caminho do agente desde v1.10.4. O mock não monta
    // modos diferentes; devolve os mesmos bytes (ignora `mode`) — basta pro dev.
    if (path === '/api/print-queue/claim-lease' && method === 'POST') {
      const body = await readJson(req).catch((): Record<string, unknown> => ({}))
      const max = typeof body['max'] === 'number' ? (body['max'] as number) : 5
      const now = Date.now()
      for (const item of queue) {
        if (item.status === 'leased' && item.leasedUntil !== undefined && item.leasedUntil < now) {
          item.status = 'pending'
          delete item.leasedUntil
        }
      }
      const leased = queue.filter((q) => q.status === 'pending').slice(0, max)
      for (const item of leased) {
        item.status = 'leased'
        item.leasedUntil = now + 120_000
      }
      const items = leased.map((q) => ({
        id: q.id,
        orderId: q.orderNumber,
        reason: 'new_order',
        paperWidth: q.payload.paperWidth === 58 ? '58mm' : '80mm',
        paperWidthMm: q.payload.paperWidth,
        bytesBase64: q.payload.bytes
      }))
      return send(res, 200, { items, payloadVersion: 1 })
    }

    if (path === '/api/print-queue/test-receipt' && method === 'POST') {
      const body = await readJson(req).catch((): Record<string, unknown> => ({}))
      const mode = typeof body['mode'] === 'string' ? (body['mode'] as string) : 'escpos'
      const pw = body['paperWidth'] === 58 ? 58 : 80
      const sample = `TESTE [${mode}]\nLinguica, Debito, acao, pao\n\n`
      return send(res, 200, {
        mode,
        paperWidth: pw === 58 ? '58mm' : '80mm',
        paperWidthMm: pw,
        bytesBase64: Buffer.from(sample, 'utf8').toString('base64'),
        payloadVersion: 1
      })
    }

    const claimMatch = path.match(/^\/api\/print-queue\/([\w-]+)\/claim$/)
    if (claimMatch && method === 'POST') {
      const id = claimMatch[1]!
      const item = queue.find((q) => q.id === id)
      if (!item) return send(res, 404, { error: 'NOT_FOUND' })
      if (item.status !== 'pending') return send(res, 409, { error: 'NOT_AVAILABLE' })
      item.status = 'leased'
      item.leasedUntil = Date.now() + 120_000
      return send(res, 200, {
        item: { id: item.id, orderNumber: item.orderNumber },
        leaseExpiresAt: new Date(item.leasedUntil).toISOString(),
        payload: item.payload
      })
    }

    const ackMatch = path.match(/^\/api\/print-queue\/([\w-]+)\/ack$/)
    if (ackMatch && method === 'POST') {
      const id = ackMatch[1]!
      const idx = queue.findIndex((q) => q.id === id)
      if (idx === -1) return send(res, 404, { error: 'NOT_FOUND' })
      queue.splice(idx, 1)
      return send(res, 204)
    }

    const releaseMatch = path.match(/^\/api\/print-queue\/([\w-]+)\/release$/)
    if (releaseMatch && method === 'POST') {
      const id = releaseMatch[1]!
      const item = queue.find((q) => q.id === id)
      if (!item) return send(res, 404, { error: 'NOT_FOUND' })
      item.status = 'pending'
      delete item.leasedUntil
      await readJson(req).catch((): Record<string, unknown> => ({}))
      return send(res, 204)
    }

    if (path === '/api/print-agent/ping' && method === 'POST') {
      await readJson(req).catch((): Record<string, unknown> => ({}))
      return send(res, 204)
    }

    if (path === '/api/print-agent/telemetry' && method === 'POST') {
      await readJson(req).catch((): Record<string, unknown> => ({}))
      return send(res, 204)
    }

    return send(res, 404, { error: 'NOT_FOUND' })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[mock-backend] error:', e)
      send(res, 500, { error: 'INTERNAL' })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      console.log(`[mock-backend] http://127.0.0.1:${port}`)
      resolve({
        port,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
        seedJob: (opts) => {
          const id = opts?.id ?? `job_${randomUUID().slice(0, 8)}`
          const orderNumber = opts?.orderNumber ?? String(1000 + queue.length + 1)
          const bodyText = opts?.bodyText ?? `MOCK PEDIDO #${orderNumber}\n\nItem 1 x1\nTotal R$ 0,00\n\n`
          queue.push({
            id,
            orderNumber,
            status: 'pending',
            payload: {
              bytes: Buffer.from(bodyText, 'utf8').toString('base64'),
              paperWidth: opts?.paperWidth ?? 80,
              copies: opts?.copies ?? 1
            }
          })
          return id
        },
        state: () => ({ queue: [...queue], issuedTokens: issuedAccessTokens.size })
      })
    })
  })
}
