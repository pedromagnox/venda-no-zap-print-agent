import { EventEmitter } from 'node:events'
import type {
  AgentStatus,
  AgentSnapshot,
  HistoryEntry,
  LogEntry,
  PrinterConfig,
  Preferences
} from '@shared/types'

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

  setConnection(connected: boolean, storeName: string | null): void {
    if (
      connected === this.snap.connection.connected &&
      storeName === this.snap.connection.storeName
    ) {
      return
    }
    this.patch({ connection: { connected, storeName } })
  }

  setPrinter(printer: PrinterConfig): void {
    this.patch({ printer })
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
    history: [],
    logs: [],
    preferences: { autoStart: true },
    connection: { connected: false, storeName: null },
    version
  }
}
