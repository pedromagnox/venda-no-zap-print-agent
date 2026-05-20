import { app } from 'electron'

// Defaults dependem de packaged vs dev. Override via process.env (dotenv não é
// carregado automaticamente — quem quiser pode rodar `node --env-file=.env ...`
// ou setar manualmente. Defaults cobrem o caso comum.).
const packaged = app.isPackaged

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return def
  return v === '1' || v.toLowerCase() === 'true'
}

function envNum(name: string, def: number): number {
  const v = process.env[name]
  if (!v) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

// Mock só em dev e por default ON.
const useMock = !packaged && envBool('PRINT_AGENT_USE_MOCK', true)
const mockPort = envNum('PRINT_AGENT_MOCK_PORT', 4317)

// Em prod a API mora em api.vendanozap.app (Fly), não na raiz vendanozap.app
// (que é Cloudflare Worker + Static Assets desde mai/2026). Installers
// antigos (<= v0.2.x) usavam vendanozap.app — o Worker proxia /api/print-*
// transparentemente como safety net, mas novos builds vão direto.
const defaultApiBase = packaged
  ? 'https://api.vendanozap.app'
  : useMock
    ? `http://127.0.0.1:${mockPort}`
    : 'http://localhost:3000'

export const config = {
  packaged,
  apiBaseUrl: process.env['PRINT_AGENT_API_BASE_URL'] ?? defaultApiBase,
  useMock,
  mockPort,
  // Loop de polling — centralizado aqui pra fácil ajuste.
  // Default 30s: reduz carga no api Fly em 6x vs valor original (5s) sem
  // impacto perceptível pro lojista (pedido novo demora até 30s pra
  // aparecer na fila, ainda dentro do esperado pra impressão automática).
  // Lojistas com muito volume podem reduzir via env var.
  pollIntervalMs: envNum('PRINT_AGENT_POLL_MS', 30_000),
  heartbeatIntervalMs: envNum('PRINT_AGENT_HEARTBEAT_MS', 30_000),
} as const

export type Config = typeof config
