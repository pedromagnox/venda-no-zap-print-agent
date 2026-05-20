import type { PrinterConfig } from '@shared/types'
import { NetworkPrinter } from './network'
import { WindowsSpoolerPrinter } from './spooler'
import { PrinterError, type Printer } from './types'

export { PrinterError } from './types'
export type { Printer, PrinterErrorCode } from './types'
export { buildTestPage } from './escpos-test'
export { listSpoolerPrinters } from './discovery'
export type { DiscoveredSpoolerPrinter } from './discovery'

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
