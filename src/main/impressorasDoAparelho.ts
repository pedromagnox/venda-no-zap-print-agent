import { hasPrinterTarget } from '@lib/printer'
import { CHAVE_PRINCIPAL, type PrinterConfig, type PrintModeSelection } from '@shared/types'
import { formatLogTime } from '@shared/logTime'
import type { AgentState } from './agentState'
import type { StoreConnection } from './storeConnection'

export function descricaoDaImpressora(config: PrinterConfig): string {
  if (config.type === 'network') return 'Rede'
  return (config.spoolerName ?? '').slice(0, 80)
}

export function modosDasExtras(state: AgentState): Record<string, PrintModeSelection> {
  return Object.fromEntries(
    state
      .get()
      .extras.filter((e) => hasPrinterTarget(e.config))
      .map((e) => [e.chave, e.config.printMode ?? 'escpos'])
  )
}

/** Manda à loja as impressoras deste computador que têm alvo (a principal e as a mais) e guarda os nomes que ela deu. */
export async function sincronizarImpressoras(
  state: AgentState,
  connections: Map<string, StoreConnection>
): Promise<void> {
  const snap = state.get()
  const lista = [{ chave: CHAVE_PRINCIPAL, config: snap.printer }, ...snap.extras]
    .filter((i) => hasPrinterTarget(i.config))
    .map((i) => ({ chave: i.chave, descricao: descricaoDaImpressora(i.config) || null }))
  let nomesGuardados = false
  for (const conn of connections.values()) {
    try {
      const r = await conn.endpoints.registrarImpressoras(lista)
      if (!nomesGuardados) {
        state.setNomesDasImpressoras(Object.fromEntries(r.impressoras.map((i) => [i.chave, i.nome])))
        nomesGuardados = true
      }
    } catch (err) {
      state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `Não deu para mandar as impressoras deste computador para a loja: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }
}
