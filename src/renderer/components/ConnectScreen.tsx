import { Logo } from './Logo'

type ConnectScreenProps = {
  token: string
  connecting: boolean
  errorMessage: string | null
  onTokenChange: (next: string) => void
  onConnect: () => void
}

export function ConnectScreen({
  token,
  connecting,
  errorMessage,
  onTokenChange,
  onConnect
}: ConnectScreenProps): JSX.Element {
  return (
    <div className="connect-screen">
      <div className="connect-screen-hero">
        <Logo size={56} />
        <h1>Conectar à sua loja</h1>
        <p>Cole abaixo o token gerado no Venda no Zap</p>
        <div className="connect-screen-hint">
          <div className="connect-screen-hint-label">DICA</div>
          <div>
            fica abaixo do botão que você
            <br />
            usou para baixar esse aplicativo
          </div>
        </div>
      </div>

      <div className="connect-screen-card">
        <div className="field">
          <label className="label">Token de conexão</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              type="text"
              placeholder="Cole o token aqui"
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              style={{ flex: 1, minWidth: 0 }}
              autoFocus
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
              Colar
            </button>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={onConnect}
          disabled={!token.trim() || connecting}
        >
          {connecting ? 'Conectando…' : 'Conectar'}
        </button>

        {errorMessage && (
          <div className="connect-screen-error" role="alert">
            {errorMessage}
          </div>
        )}
      </div>
    </div>
  )
}
