import type { ApiClient } from './client'
import type {
  ClaimResponse,
  PingRequest,
  QueueListItem,
  QueueListResponse,
  ReleaseRequest,
  TelemetryEvent
} from './types'

// Métodos tipados sobre o cliente. Centraliza paths e shape dos requests
// e normaliza diferenças de naming entre versões do backend.

export class PrintAgentEndpoints {
  constructor(private readonly api: ApiClient) {}

  /**
   * GET /api/print-queue
   *
   * Tolerante a:
   *   - Envelope: { items: [...] }   (esperado)
   *   - Array direto: [...]          (backend pré-envelope)
   *   - item.orderNumber OU item.orderId  (nomes diferentes do mesmo campo)
   */
  async listQueue(): Promise<QueueListResponse> {
    const raw = await this.api.getJson<unknown>('/api/print-queue')
    const rawItems = extractItemsArray(raw)
    return { items: rawItems.map(normalizeQueueItem) }
  }

  /**
   * POST /api/print-queue/:id/claim
   *
   * Normaliza item.orderNumber a partir de item.orderId quando o backend
   * só manda esse campo (o que aconteceu até a v0.1.1). paperWidth/paperWidthMm
   * são normalizados depois pelo queueLoop.
   */
  async claim(id: string): Promise<ClaimResponse> {
    const raw = await this.api.postJson<Record<string, unknown>>(
      `/api/print-queue/${encodeURIComponent(id)}/claim`,
      {}
    )
    return normalizeClaimResponse(raw, id)
  }

  ack(id: string): Promise<void> {
    return this.api.post(`/api/print-queue/${encodeURIComponent(id)}/ack`)
  }

  release(id: string, body: ReleaseRequest): Promise<void> {
    return this.api.post(`/api/print-queue/${encodeURIComponent(id)}/release`, body)
  }

  ping(body: PingRequest): Promise<void> {
    return this.api.post('/api/print-agent/ping', body)
  }

  telemetry(event: TelemetryEvent): Promise<void> {
    return this.api.post('/api/print-agent/telemetry', event)
  }
}

function extractItemsArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    console.warn('[api] /api/print-queue retornou array direto — usando fallback (envelope esperado).')
    return raw
  }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { items?: unknown }).items)
  ) {
    return (raw as { items: unknown[] }).items
  }
  console.warn('[api] /api/print-queue retornou formato inesperado:', raw)
  return []
}

function normalizeQueueItem(it: unknown): QueueListItem {
  if (!it || typeof it !== 'object') {
    return { id: 'unknown', orderNumber: 'unknown' }
  }
  const o = it as Record<string, unknown>
  const id = strOr(o.id, 'unknown')
  const orderNumber = strOr(o.orderNumber, strOr(o.orderId, id))
  const createdAt = typeof o.createdAt === 'string' ? o.createdAt : undefined
  return { id, orderNumber, createdAt }
}

function normalizeClaimResponse(
  raw: Record<string, unknown>,
  fallbackId: string
): ClaimResponse {
  const itemRaw = (raw.item ?? {}) as Record<string, unknown>
  const payloadRaw = (raw.payload ?? {}) as Record<string, unknown>
  const id = strOr(itemRaw.id, fallbackId)
  const orderNumber = strOr(itemRaw.orderNumber, strOr(itemRaw.orderId, id))
  return {
    item: { id, orderNumber },
    leaseExpiresAt: strOr(raw.leaseExpiresAt, ''),
    payload: {
      bytes: strOr(payloadRaw.bytes, ''),
      // paperWidth/paperWidthMm são repassados crus — queueLoop.normalizePaperWidth
      // resolve a normalização final.
      paperWidth: payloadRaw.paperWidth as ClaimResponse['payload']['paperWidth'],
      paperWidthMm: payloadRaw.paperWidthMm as ClaimResponse['payload']['paperWidthMm'],
      copies: typeof payloadRaw.copies === 'number' ? payloadRaw.copies : 1
    }
  }
}

function strOr(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}
