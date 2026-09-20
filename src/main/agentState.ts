import { EventEmitter } from 'node:events'
import type {
  AgentStatus,
  StoreConnectionInfo,
  AgentSnapshot,
  HistoryEntry,
  LogEntry,
  PrinterConfig,
  Preferences,
  PrintMode
} from '@shared/types'

/** Subconjunto do AgentState que o QueueLoop/WsClient de uma loja enxergam.
 *  Interface (e não a classe) porque o adaptador de `scopedFor` precisa ser
 *  compatível estruturalmente — AgentState tem campos privados. */
export type StoreScopedState = {
  get(): AgentSnapshot
  setStatus(status: AgentStatus, message?: string): void
  pushLog(entry: LogEntry): void
  pushHistory(entry: HistoryEntry): void
  setPrintMode(mode: PrintMode, driver: string | null): void
}

const MAX_HISTORY = 50
const MAX_LOGS = 100

// Estado central do main process. Emite 'change' a cada update — o ipc.ts
// faz fan-out pro renderer. Idempotente: setX() só dispara se realmente mudou.
export class AgentState extends EventEmitter {
  private snap: AgentSnapshot
  private logSink: ((entry: LogEntry) => void) | null = null

  constructor(initial: AgentSnapshot) {
    super()
    this.snap = initial
  }

  /**
   * Registra um callback chamado sempre que `pushLog` é executado.
   * Usado pra persistir logs no SQLite. Configurar antes de qualquer pushLog
   * pra não perder entradas do boot.
   */
  setLogSink(fn: (entry: LogEntry) => void): void {
    this.logSink = fn
  }

  get(): AgentSnapshot {
    return this.snap
  }

  patch(partial: Partial<AgentSnapshot>): void {
    this.snap = { ...this.snap, ...partial }
    this.emit('change', this.snap)
  }

  setStatus(status: AgentStatus, message?: string): void {
    if (status === this.snap.status && message === this.snap.statusMessage) return
    this.patch({
      status,
      statusMessage: message ?? this.snap.statusMessage,
      lastActionAt: new Date().toISOString()
    })
  }

  /** v1.11.0: o QueueLoop e o WsClient de CADA loja escrevem aqui. Recebem
   *  esta visão (não o AgentState inteiro) pra que `setStatus` de uma loja não
   *  apague o status da outra — ver `scopedFor`. */
  setStoreStatus(storeId: string, status: AgentStatus, message: string): void {
    const stores = this.snap.stores.map((s) =>
      s.storeId === storeId ? { ...s, status, statusMessage: message } : s
    )
    this.patch({ stores })
    this.recomputeGlobal()
  }

  upsertStore(info: StoreConnectionInfo): void {
    const i = this.snap.stores.findIndex((s) => s.storeId === info.storeId)
    const stores = i >= 0 ? this.snap.stores.map((s, k) => (k === i ? info : s)) : [...this.snap.stores, info]
    this.patch({ stores })
    this.recomputeGlobal()
  }

  removeStore(storeId: string): void {
    this.patch({ stores: this.snap.stores.filter((s) => s.storeId !== storeId) })
    this.recomputeGlobal()
  }

  /** Bandeja e cabeçalho mostram UM estado; com N lojas mostramos o PIOR
   *  (vermelho > amarelo > verde). Uma loja quebrada não pode ficar escondida
   *  atrás de outra saudável. `connection` espelha a primeira loja — é o que o
   *  gate de onboarding usa pra saber se já há alguma conexão. */
  private recomputeGlobal(): void {
    const stores = this.snap.stores
    if (stores.length === 0) {
      this.setConnection(false, null, null)
      return
    }
    const first = stores[0]!
    this.setConnection(true, first.storeName, first.storeId)
    const rank = (s: AgentStatus): number => (s === 'red' ? 2 : s === 'yellow' ? 1 : 0)
    const worst = stores.reduce((acc, s) => (rank(s.status) > rank(acc.status) ? s : acc), first)
    const prefix = stores.length > 1 ? `${worst.storeName}: ` : ''
    this.setStatus(worst.status, `${prefix}${worst.statusMessage}`)
  }

  /** Visão do estado amarrada a uma loja. */
  scopedFor(storeId: string): StoreScopedState {
    return {
      get: () => this.get(),
      setStatus: (status, message) => this.setStoreStatus(storeId, status, message ?? ''),
      pushLog: (entry) => {
        const many = this.snap.stores.length > 1
        const name = this.snap.stores.find((s) => s.storeId === storeId)?.storeName
        // Com 2+ lojas o log vira ilegível sem saber de quem é a linha.
        this.pushLog(many && name ? { ...entry, message: `[${name}] ${entry.message}` } : entry)
      },
      pushHistory: (h) => this.pushHistory(h),
      setPrintMode: (mode, driver) => this.setPrintMode(mode, driver)
    }
  }

  setConnection(connected: boolean, storeName: string | null, storeId: string | null): void {
    if (
      connected === this.snap.connection.connected &&
      storeName === this.snap.connection.storeName &&
      storeId === this.snap.connection.storeId
    ) {
      return
    }
    this.patch({ connection: { connected, storeName, storeId } })
  }

  setPrinter(printer: PrinterConfig): void {
    this.patch({ printer })
  }

  setPrintMode(mode: PrintMode, driver: string | null): void {
    if (mode === this.snap.printMode && driver === this.snap.printerDriver) return
    this.patch({ printMode: mode, printerDriver: driver })
  }

  setPreferences(prefs: Preferences): void {
    this.patch({ preferences: prefs })
  }

  pushHistory(entry: HistoryEntry): void {
    const history = [entry, ...this.snap.history].slice(0, MAX_HISTORY)
    this.patch({ history })
  }

  pushLog(entry: LogEntry): void {
    const enriched: LogEntry = {
      ...entry,
      timeMs: entry.timeMs ?? Date.now()
    }
    const logs = [enriched, ...this.snap.logs].slice(0, MAX_LOGS)
    this.patch({ logs })
    if (this.logSink) {
      try {
        this.logSink(enriched)
      } catch {
        /* persistência best-effort; falha não deve quebrar o agente */
      }
    }
  }

}

export function makeInitialSnapshot(version: string): AgentSnapshot {
  return {
    status: 'yellow',
    statusMessage: 'Aguardando configuração da impressora e conexão.',
    lastActionAt: null,
    // Default = spooler do Windows (95% dos lojistas têm a impressora térmica
    // instalada via driver do fabricante e ela aparece em "Dispositivos e
    // Impressoras"). Rede fica atrás de "Conexão por rede" na UI pra casos
    // de impressora com IP fixo.
    printer: { type: 'windows_spooler', spoolerName: '', paperWidth: 80 },
    printMode: 'escpos',
    printerDriver: null,
    history: [],
    logs: [],
    preferences: { autoStart: true },
    connection: { connected: false, storeName: null, storeId: null },
    stores: [],
    version
  }
}
