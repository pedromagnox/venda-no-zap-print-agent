// Tipos compartilhados entre todos os drivers de impressora.
// Mantém a interface enxuta: tentar imprimir / testar conexão / descrever pra log.

export type PrinterErrorCode =
  | 'TIMEOUT'
  | 'CONN_REFUSED'
  | 'OFFLINE'
  | 'DRIVER_MISSING'
  | 'ACCESS_DENIED'
  | 'PAPER_OUT'
  | 'IO_ERROR'
  | 'INVALID_CONFIG'
  | 'NOT_IMPLEMENTED'

export class PrinterError extends Error {
  constructor(
    public readonly code: PrinterErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PrinterError'
  }
}

export interface Printer {
  // Envia bytes (ESC/POS já encodados pelo backend, NUNCA reaplicar encoding).
  print(bytes: Buffer): Promise<void>
  // Verifica conectividade sem imprimir nada (quando suportado pelo driver).
  test(): Promise<void>
  // Descrição pra logs/telemetria — não inclui dados sensíveis.
  describe(): string
  // Libera recursos pendentes (sockets, handles do spooler, etc). Idempotente.
  close(): Promise<void>
}
