// Defesa em profundidade contra logs/telemetria vazarem segredo.
// Aplicado em qualquer string que entra em log persistido ou payload de telemetria.
//
// O backend já rejeita telemetria com "dados sensíveis do cliente" — esta camada
// é redundância: rejeita Bearer tokens e qualquer string-like-token de ≥32 chars.

const BEARER_RE = /Bearer\s+\S+/gi
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{32,}/g

export function sanitize(input: string): string {
  return input.replace(BEARER_RE, 'Bearer ***').replace(LONG_TOKEN_RE, '***')
}

// host de impressora: tira esquema/credenciais se vier por acaso embutido.
export function sanitizeHost(host: string): string {
  return host
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .slice(0, 100)
}
