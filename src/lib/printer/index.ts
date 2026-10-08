import type { PrinterConfig } from '@shared/types'
import { NetworkPrinter } from './network'
import { WindowsSpoolerPrinter } from './spooler'
import { PrinterError, type Printer } from './types'

export { PrinterError } from './types'
export type { Printer, PrinterErrorCode } from './types'
export { buildTestPage, buildTestPageText } from './escpos-test'
export { listSpoolerPrinters, isTextOnlyDriver } from './discovery'
export type { DiscoveredSpoolerPrinter } from './discovery'
export { detectPrintMode } from './detectMode'
export type { DetectedMode } from './detectMode'

/** Tem alvo de impressão escolhido (fila do Windows ou IP)? Sem isso o
 *  makePrinter falha com INVALID_CONFIG. Usado pra NÃO pegar pedido sem
 *  impressora e pra informar o painel no ping (v1.11.2). */
export function hasPrinterTarget(config: PrinterConfig): boolean {
  if (config.type === 'windows_spooler') return (config.spoolerName ?? '').trim() !== ''
  if (config.type === 'network') return (config.host ?? '').trim() !== ''
  return false
}

export function makePrinter(config: PrinterConfig): Printer {
  switch (config.type) {
    case 'network': {
      const host = (config.host ?? '').trim()
      if (!host) {
        throw new PrinterError('INVALID_CONFIG', 'IP da impressora não definido')
      }
      return new NetworkPrinter(host, config.port ?? 9100)
    }
    case 'windows_spooler': {
      const name = (config.spoolerName ?? '').trim()
      if (!name) {
        throw new PrinterError('INVALID_CONFIG', 'impressora do spooler não selecionada')
      }
      return new WindowsSpoolerPrinter(name)
    }
  }
}
