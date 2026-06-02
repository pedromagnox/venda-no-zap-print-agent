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
  // Envia dados pra impressora. Buffer = bytes ESC/POS RAW (já encodados pelo
  // backend, NUNCA reaplicar encoding). string = texto puro pro driver
  // renderizar (modo compatibilidade — usado quando o driver é Generic/Text
  // Only e ESC/POS não funciona). Spooler decide TEXT vs RAW pelo tipo do
  // argumento. NetworkPrinter rejeita string (TCP raw não tem driver).
  //
  // docname: rótulo do job exibido na fila de impressão do Windows. Ignorado
  // por drivers que não passam pelo spooler (ex.: rede TCP raw).
  print(data: Buffer | string, docname?: string): Promise<void>
  // Verifica conectividade sem imprimir nada (quando suportado pelo driver).
  test(): Promise<void>
  // Descrição pra logs/telemetria — não inclui dados sensíveis.
  describe(): string
  // Libera recursos pendentes (sockets, handles do spooler, etc). Idempotente.
  close(): Promise<void>
}
