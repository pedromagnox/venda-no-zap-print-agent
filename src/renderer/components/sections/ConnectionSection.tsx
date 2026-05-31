import type { AgentStatus } from '@shared/types'

type ConnectionSectionProps = {
  connected: boolean
  storeName: string | null
  status: AgentStatus
  statusLabel: string
  statusMessage: string
  token: string
  connecting?: boolean
  onTokenChange: (next: string) => void
  onReconnect: () => void
  onDisconnect: () => void
}

export function ConnectionSection({
  connected,
  storeName,
  status,
  statusLabel,
  statusMessage,
  token,
  connecting = false,
  onTokenChange,
  onReconnect,
  onDisconnect
}: ConnectionSectionProps): JSX.Element {
  // Forma compacta quando já conectado — economiza espaço pra dar destaque pra
  // configuração de impressora (que é o que o lojista vai mexer no dia a dia).
  // O dot e o label refletem o `status` real (green/yellow/red); o
  // `statusMessage` detalhado vira tooltip do dot pra quem quiser ver.
  if (connected) {
    return (
      <section className="section section-compact">
        <div className="connection-compact">
          <div className="connection-compact-info">
            <span
              className={`status-dot status-${status}`}
              aria-hidden
              title={statusMessage}
            />
            <div>
              <div className="connection-compact-label">{statusLabel}</div>
              <div className="connection-compact-store">{storeName ?? 'Loja'}</div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '4px 10px', fontSize: '0.72rem' }}
            onClick={onDisconnect}
          >
            Desconectar
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Conexão</span>
        <span className="status-dot status-red" />
      </div>

      <div className="field">
        <label className="label">Token de conexão</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            type="text"
            placeholder="Cole o token gerado no painel da loja"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            className="btn"
            style={{ whiteSpace: 'nowrap' }}
            onClick={async () => {
              const text = await window.printAgent.readClipboard()
              const trimmed = text.trim()
              if (trimmed) onTokenChange(trimmed)
            }}
            title="Cola o token da área de transferência"
          >
            Colar Token
          </button>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={onReconnect}
        disabled={!token.trim() || connecting}
      >
        {connecting ? 'Conectando…' : 'Conectar'}
      </button>
    </section>
  )
}
