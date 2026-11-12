import { hasPrinterTarget } from '@lib/printer'
import { alvoBluetoothDaFila } from '@lib/printer/semFila'
import { writeJsonFile } from '@lib/storage/jsonStore'
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

export async function alvoFisico(config: PrinterConfig): Promise<string | null> {
  if (config.type === 'network') {
    const host = config.host?.trim().toLowerCase()
    return host ? `rede:${host}:${config.port ?? 9100}` : null
  }
  try {
    return await alvoBluetoothDaFila(config.spoolerName ?? '')
  } catch {
    return null
  }
}

async function aplicarLarguras(state: AgentState, larguras: Record<string, 58 | 80>): Promise<void> {
  const snap = state.get()
  const principal = larguras[CHAVE_PRINCIPAL]
  if (principal && !snap.printer.larguraEscolhida && snap.printer.paperWidth !== principal) {
    const printer = { ...snap.printer, paperWidth: principal }
    state.setPrinter(printer)
    await writeJsonFile('printer', printer)
  }
  let mudou = false
  const extras = snap.extras.map((e) => {
    const largura = larguras[e.chave]
    if (!largura || e.config.larguraEscolhida || e.config.paperWidth === largura) return e
    mudou = true
    return { ...e, config: { ...e.config, paperWidth: largura } }
  })
  if (mudou) {
    state.setExtras(extras)
    await writeJsonFile('impressoras-extras', extras)
  }
}

/** Manda à loja as impressoras deste computador que têm alvo (a principal e as a mais) e guarda os nomes que ela deu. */
export async function sincronizarImpressoras(
  state: AgentState,
  connections: Map<string, StoreConnection>
): Promise<void> {
  const snap = state.get()
  const lista = await Promise.all(
    [{ chave: CHAVE_PRINCIPAL, config: snap.printer }, ...snap.extras]
      .filter((i) => hasPrinterTarget(i.config))
      .map(async (i) => ({
        chave: i.chave,
        descricao: descricaoDaImpressora(i.config) || null,
        alvo: await alvoFisico(i.config),
        ...(i.config.larguraEscolhida ? { largura: i.config.paperWidth } : {})
      }))
  )
  let nomesGuardados = false
  for (const conn of connections.values()) {
    try {
      const r = await conn.endpoints.registrarImpressoras(lista)
      if (!nomesGuardados) {
        state.setNomesDasImpressoras(Object.fromEntries(r.impressoras.map((i) => [i.chave, i.nome])))
        nomesGuardados = true
        const daLoja = r.larguraDaLoja
        if (daLoja === 58 || daLoja === 80) {
          await aplicarLarguras(
            state,
            Object.fromEntries(
              r.impressoras.map((i) => [i.chave, i.largura === 58 || i.largura === 80 ? i.largura : daLoja])
            )
          )
        }
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
