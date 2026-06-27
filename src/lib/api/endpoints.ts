import type { ApiClient } from './client'
import type {
  ClaimLeaseResponse,
  ClaimOpts,
  ClaimResponse,
  LeaseItem,
  PingRequest,
  PrintModeSelection,
  QueueListItem,
  QueueListResponse,
  ReleaseRequest,
  TelemetryEvent,
  TestReceiptResult
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
   *
   * opts.mode='ascii' ativa o backend pra retornar `payload.text` em vez de
   * `payload.bytes` (modo compatibilidade, ver shared/types PrintMode).
   * Backends antigos (payloadVersion=1) ignoram o body e retornam ESC/POS.
   */
  async claim(id: string, opts?: ClaimOpts): Promise<ClaimResponse> {
    const body: Record<string, unknown> = {}
    if (opts?.mode) body.mode = opts.mode
    if (opts?.paperWidth) body.paperWidth = opts.paperWidth
    const raw = await this.api.postJson<Record<string, unknown>>(
      `/api/print-queue/${encodeURIComponent(id)}/claim`,
      body
    )
    return normalizeClaimResponse(raw, id)
  }

  /**
   * POST /api/print-queue/claim-lease  (v1.10.4: caminho único de claim)
   *
   * Lease atômico de até `max` itens, já com os bytes ESC/POS montados no
   * `mode` pedido (escpos/ascii/raster) — todos RAW. Substitui o listQueue +
   * /claim/:id por-item (que era escpos/ascii apenas, sem raster).
   *
   * `mode` vai SEMPRE — sem ele o backend cai na flag da loja (comportamento
   * antigo), que não queremos. Tolerante ao envelope `{items}` (reusa
   * extractItemsArray).
   */
  async claimLease(max: number, mode: PrintModeSelection): Promise<ClaimLeaseResponse> {
    const raw = await this.api.postJson<unknown>('/api/print-queue/claim-lease', { max, mode })
    return { items: extractItemsArray(raw).map(normalizeLeaseItem) }
  }

  /**
   * POST /api/print-queue/test-receipt
   *
   * Cupom-amostra (cheio de acento) renderizado no `mode` pedido. O raster só o
   * servidor desenha, então o teste de todos os modos vem pronto em bytes — o
   * agente só repassa RAW. Usado pelo wizard de modo de impressão.
   */
  async testReceipt(mode: PrintModeSelection, paperWidth?: 58 | 80): Promise<TestReceiptResult> {
    const body: Record<string, unknown> = { mode }
    if (paperWidth) body.paperWidth = paperWidth
    const raw = await this.api.postJson<Record<string, unknown>>(
      '/api/print-queue/test-receipt',
      body
    )
    return {
      mode: (raw.mode as PrintModeSelection) ?? mode,
      paperWidth: raw.paperWidth as TestReceiptResult['paperWidth'],
      paperWidthMm: raw.paperWidthMm as TestReceiptResult['paperWidthMm'],
      bytesB64: strOr(raw.bytesBase64, '')
    }
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

function normalizeLeaseItem(it: unknown): LeaseItem {
  const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
  const id = strOr(o.id, 'unknown')
  // claim-lease não traz número amigável — só `orderId` (UUID). Usamos como
  // identificador de exibição/histórico. Se um dia o backend mandar
  // `orderNumber`, ele tem precedência.
  const orderNumber = strOr(o.orderNumber, strOr(o.orderId, id))
  const reason = typeof o.reason === 'string' ? o.reason : undefined
  return {
    id,
    orderNumber,
    ...(reason ? { reason } : {}),
    bytesB64: strOr(o.bytesBase64, ''),
    paperWidth: o.paperWidth as LeaseItem['paperWidth'],
    paperWidthMm: o.paperWidthMm as LeaseItem['paperWidthMm']
  }
}

function normalizeClaimResponse(
  raw: Record<string, unknown>,
  fallbackId: string
): ClaimResponse {
  const itemRaw = (raw.item ?? {}) as Record<string, unknown>
  const payloadRaw = (raw.payload ?? {}) as Record<string, unknown>
  const id = strOr(itemRaw.id, fallbackId)
  const orderNumber = strOr(itemRaw.orderNumber, strOr(itemRaw.orderId, id))
  // v1.10.0: backend devolve `item.reason` ('new_order', 'status:<novo>',
  // 'manual_reprint', etc.). Backends antigos ignoram esse campo.
  const reason = typeof itemRaw.reason === 'string' ? itemRaw.reason : undefined
  // mode='ascii' identifica o novo shape com `text`. Backends antigos
  // (payloadVersion=1) não mandam `mode` e sempre retornam `bytes`.
  const mode = payloadRaw.mode === 'ascii' ? 'ascii' : 'escpos'
  const paperWidth = payloadRaw.paperWidth as ClaimResponse['payload']['paperWidth']
  const paperWidthMm = payloadRaw.paperWidthMm as ClaimResponse['payload']['paperWidthMm']
  const copies = typeof payloadRaw.copies === 'number' ? payloadRaw.copies : 1
  return {
    item: { id, orderNumber, ...(reason ? { reason } : {}) },
    leaseExpiresAt: strOr(raw.leaseExpiresAt, ''),
    payload: mode === 'ascii'
      ? { mode: 'ascii', text: strOr(payloadRaw.text, ''), paperWidth, paperWidthMm, copies }
      : { mode: 'escpos', bytes: strOr(payloadRaw.bytes, ''), paperWidth, paperWidthMm, copies }
  }
}

function strOr(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}
