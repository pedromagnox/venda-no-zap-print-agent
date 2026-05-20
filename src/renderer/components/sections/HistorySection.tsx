import type { HistoryEntry } from '@shared/types'

type HistorySectionProps = {
  entries: HistoryEntry[]
}

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Histórico read-only — reimpressão é feita pelo painel web na seção de falhas
// (mantemos um único caminho pra evitar divergência entre desktop/painel).

export function HistorySection({ entries }: HistorySectionProps): JSX.Element {
  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Pedidos recentes</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          últimos {entries.length}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="empty">Nenhum pedido impresso ainda.</div>
      ) : (
        <div className="history-list">
          {entries.map((e) => (
            <div key={e.id} className="history-item">
              <span className="h-time">{fmtTime(e.printedAt)}</span>
              <span className="h-id">#{e.orderNumber}</span>
              <span className={`h-status ${e.status === 'success' ? 'ok' : 'err'}`}>
                {e.status === 'success' ? 'OK' : 'Falha'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
