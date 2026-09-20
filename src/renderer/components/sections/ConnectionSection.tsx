import { useState } from 'react'
import type { AgentStatus, StoreConnectionInfo } from '@shared/types'

type ConnectionSectionProps = {
  /** v1.11.0: lista de lojas conectadas nesta instalação. Vazia = tela de token. */
  stores: StoreConnectionInfo[]
  status: AgentStatus
  statusLabel: string
  statusMessage: string
  token: string
  connecting?: boolean
  onTokenChange: (next: string) => void
  onReconnect: () => void
  onDisconnectStore: (storeId: string) => void
}

function TokenField({
  token,
  onTokenChange
}: {
  token: string
  onTokenChange: (next: string) => void
}): JSX.Element {
  return (
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
  )
}

export function ConnectionSection({
  stores,
  status,
  statusLabel,
  statusMessage,
  token,
  connecting = false,
  onTokenChange,
  onReconnect,
  onDisconnectStore
}: ConnectionSectionProps): JSX.Element {
  // O campo de token fica escondido depois que há loja conectada — só reaparece
  // ao clicar em "Adicionar outra loja". Mantém a tela enxuta no dia a dia,
  // que é o estado normal.
  const [adding, setAdding] = useState(false)

  if (stores.length > 0) {
    return (
      <section className="section section-compact">
        {stores.map((s) => (
          <div className="connection-compact" key={s.storeId}>
            <div className="connection-compact-info">
              <span
                className={`status-dot status-${s.status}`}
                aria-hidden
                title={s.statusMessage}
              />
              <div>
                <div className="connection-compact-label">
                  {/* Com uma loja só, o rótulo global (Conectado/Erro) continua
                      valendo; com várias, cada linha mostra o estado dela. */}
                  {stores.length === 1 ? statusLabel : s.statusMessage}
                </div>
                <div className="connection-compact-store">{s.storeName}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: '4px 10px', fontSize: '0.72rem' }}
              onClick={() => onDisconnectStore(s.storeId)}
              title={`Desconectar ${s.storeName}`}
            >
              Desconectar
            </button>
          </div>
        ))}

        {adding ? (
          <div style={{ marginTop: 10 }}>
            <TokenField token={token} onTokenChange={onTokenChange} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={onReconnect}
                disabled={!token.trim() || connecting}
              >
                {connecting ? 'Conectando…' : 'Conectar loja'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setAdding(false)
                  onTokenChange('')
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            style={{ marginTop: 8, fontSize: '0.78rem' }}
            onClick={() => setAdding(true)}
          >
            + Adicionar Token de outra Loja
          </button>
        )}
      </section>
    )
  }

  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Conexão</span>
        <span className={`status-dot status-${status}`} title={statusMessage} />
      </div>

      <TokenField token={token} onTokenChange={onTokenChange} />

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
