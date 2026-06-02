import type { PrinterConfig } from '@shared/types'
import type { PrintMode } from '@shared/types'
import { listSpoolerPrinters, isTextOnlyDriver } from './discovery'

// Detecta o modo de impressão baseado no driver da impressora selecionada.
//
// Spooler com driver Generic/Text Only → 'compatibility' (cupom texto puro
// via type='TEXT' no spooler — o backend gera ASCII formatado).
//
// Spooler com driver normal OU rede TCP raw → 'escpos' (bytes binários,
// caminho default).
//
// Spooler sem nome ainda configurado, ou enrichment do PS falhou → 'escpos'
// (default seguro — ESC/POS funciona com a maioria dos drivers reais).
//
// O retorno também inclui o `driver` detectado pra UI mostrar contexto no
// badge ("Driver: Generic / Text Only").

export type DetectedMode = {
  mode: PrintMode
  driver: string | null
  /** Razão do retorno — facilita debug dos logs dos lojistas. Valores:
   *   - 'not-spooler': impressora é rede TCP (não tem driver Windows).
   *   - 'no-spooler-name': spooler selecionado mas spoolerName vazio.
   *   - 'list-failed': listSpoolerPrinters() falhou (PS timeout, módulo
   *     indisponível). NESSE caso default escpos pode esconder driver
   *     Text-Only — investigar.
   *   - 'printer-not-found': spoolerName não bate com nenhum nome listado.
   *   - 'detected': resultado válido (mode reflete o driver). */
  reason: 'not-spooler' | 'no-spooler-name' | 'list-failed' | 'printer-not-found' | 'detected'
  /** Mensagem de erro se reason === 'list-failed'. */
  error?: string
}

export async function detectPrintMode(config: PrinterConfig): Promise<DetectedMode> {
  if (config.type !== 'windows_spooler') {
    return { mode: 'escpos', driver: null, reason: 'not-spooler' }
  }
  const name = (config.spoolerName ?? '').trim()
  if (!name) {
    return { mode: 'escpos', driver: null, reason: 'no-spooler-name' }
  }
  let list
  try {
    list = await listSpoolerPrinters()
  } catch (err) {
    return {
      mode: 'escpos',
      driver: null,
      reason: 'list-failed',
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const match = list.find((p) => p.name === name)
  if (!match) {
    return { mode: 'escpos', driver: null, reason: 'printer-not-found' }
  }
  return {
    mode: match.isTextOnlyDriver ? 'compatibility' : 'escpos',
    driver: match.driverName,
    reason: 'detected'
  }
}

// Re-export pra quem importa este módulo não precisar conhecer discovery.
export { isTextOnlyDriver }
