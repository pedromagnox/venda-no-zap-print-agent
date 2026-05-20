import type { LogEntry } from '@shared/types'

type LogsSectionProps = {
  logs: LogEntry[]
  onSendSupport: () => void
}

export function LogsSection({ logs, onSendSupport }: LogsSectionProps): JSX.Element {
  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Logs recentes</span>
      </div>
      {logs.length === 0 ? (
        <div className="empty">Sem eventos recentes.</div>
      ) : (
        <div className="log-list">
          {logs.map((l, i) => (
            <div key={i} className="log-line">
              <span style={{ opacity: 0.6 }}>{l.time}</span>{' '}
              <span className={`lvl-${l.level}`}>[{l.level.toUpperCase()}]</span> {l.message}
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn btn-block"
        style={{ marginTop: 12 }}
        onClick={onSendSupport}
      >
        Enviar logs ao suporte
      </button>
    </section>
  )
}
