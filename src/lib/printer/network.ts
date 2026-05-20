import { Socket } from 'node:net'
import { PrinterError, type Printer } from './types'

// Impressora térmica em rede via TCP raw na porta padrão 9100 (Wi-Fi/Ethernet).
// Cada operação abre/fecha o próprio socket — sem connection pooling por enquanto.
// Bytes são escritos diretamente sem nenhuma transformação de encoding.

export class NetworkPrinter implements Printer {
  constructor(
    private readonly host: string,
    private readonly port: number = 9100,
    private readonly timeoutMs: number = 10_000
  ) {}

  describe(): string {
    return `tcp://${this.host}:${this.port}`
  }

  async test(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = new Socket()
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new PrinterError('TIMEOUT', `timeout conectando em ${this.host}:${this.port}`))
      }, this.timeoutMs)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.end()
        resolve()
      })
      sock.once('error', (err) => {
        clearTimeout(timer)
        reject(mapNetError(err, this.host, this.port))
      })
      sock.connect(this.port, this.host)
    })
  }

  async print(bytes: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = new Socket()
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() => {
          sock.destroy()
          reject(new PrinterError('TIMEOUT', `timeout enviando para ${this.host}:${this.port}`))
        })
      }, this.timeoutMs)

      sock.once('connect', () => {
        sock.write(bytes, (err) => {
          if (err) {
            finish(() => {
              sock.destroy()
              reject(new PrinterError('IO_ERROR', err.message))
            })
            return
          }
          // end() libera os bytes pendentes e fecha quando o kernel confirmar drain.
          sock.end(() => {
            finish(() => resolve())
          })
        })
      })
      sock.once('error', (err) => {
        finish(() => reject(mapNetError(err, this.host, this.port)))
      })
      sock.connect(this.port, this.host)
    })
  }

  async close(): Promise<void> {
    // Sem socket persistente — nada a liberar.
  }
}

function mapNetError(err: Error, host: string, port: number): PrinterError {
  const code = (err as NodeJS.ErrnoException).code
  switch (code) {
    case 'ECONNREFUSED':
      return new PrinterError('CONN_REFUSED', `conexão recusada em ${host}:${port}`)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new PrinterError('OFFLINE', `host inalcançável: ${host}`)
    case 'ETIMEDOUT':
      return new PrinterError('TIMEOUT', `timeout em ${host}:${port}`)
    case 'ENOTFOUND':
      return new PrinterError('OFFLINE', `DNS falhou: ${host}`)
    case 'ECONNRESET':
      return new PrinterError('IO_ERROR', `conexão resetada por ${host}:${port}`)
    default:
      return new PrinterError('IO_ERROR', err.message)
  }
}
