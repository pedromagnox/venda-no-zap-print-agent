import { useEffect, useState } from 'react'
import { Logo } from './components/Logo'
import { ConnectScreen } from './components/ConnectScreen'
import { PrinterSection } from './components/sections/PrinterSection'
import { HistorySection } from './components/sections/HistorySection'
import { LogsSection } from './components/sections/LogsSection'
import { ConnectionSection } from './components/sections/ConnectionSection'
import { PreferencesSection } from './components/sections/PreferencesSection'
import type { AgentSnapshot } from '@shared/types'

const SUPPORT_WHATSAPP_NUMBER = '5511921048695'

// Limite conservador pra URL não estourar no wa.me/cliente WhatsApp.
// O whatsapp suporta mensagens grandes, mas URLs muito longas falham em
// alguns sistemas. ~3000 chars cabe ~30-40 linhas de log + cabeçalho.
const SUPPORT_MESSAGE_MAX_CHARS = 3000

function buildSupportUrl(snap: AgentSnapshot): string {
  const lines: string[] = []
  lines.push('Olá, preciso de suporte com o Print Agent.')
  lines.push('')
  lines.push(`Versão: v${snap.version}`)
  if (snap.connection.storeName) {
    lines.push(`Loja: ${snap.connection.storeName}`)
  }
  lines.push(`Status: ${snap.statusMessage}`)
  lines.push(`Data: ${new Date().toLocaleString('pt-BR')}`)
  lines.push('')
  lines.push('— Logs recentes —')
  if (snap.logs.length === 0) {
    lines.push('(sem logs)')
  } else {
    for (const log of snap.logs) {
      lines.push(`${log.time} [${log.level.toUpperCase()}] ${log.message}`)
    }
  }
  let text = lines.join('\n')
  if (text.length > SUPPORT_MESSAGE_MAX_CHARS) {
    text = text.slice(0, SUPPORT_MESSAGE_MAX_CHARS) + '\n…(mensagem truncada)'
  }
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`
}

const STATUS_BAR_LABEL: Record<AgentSnapshot['status'], string> = {
  green: 'Tudo certo',
  yellow: 'Atenção',
  red: 'Erro crítico'
}

export function App(): JSX.Element {
  const [snap, setSnap] = useState<AgentSnapshot | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isTesting, setIsTesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.printAgent
      .getSnapshot()
      .then((s) => {
        if (!cancelled) setSnap(s)
      })
      .catch(() => {})
    const unsub = window.printAgent.onSnapshot(setSnap)
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  if (!snap) {
    return (
      <div className="app">
        <div className="title-bar">
          <span className="title-bar-logo">
            <Logo size={18} />
          </span>
          Venda no Zap Print Agent
        </div>
        <main className="app-body">
          <div className="empty">Carregando…</div>
        </main>
      </div>
    )
  }

  const [connectError, setConnectError] = useState<string | null>(null)

  const handleConnect = async (): Promise<void> => {
    if (!tokenInput.trim() || isConnecting) return
    setIsConnecting(true)
    setConnectError(null)
    try {
      const result = await window.printAgent.connect(tokenInput)
      if (result.ok) {
        setTokenInput('')
      } else {
        setConnectError(result.error)
      }
    } finally {
      setIsConnecting(false)
    }
  }

  // Tela focada quando a sessão é terminal-inválida (sem token salvo,
  // refresh-rejected ou logout manual). Quedas temporárias de rede NÃO
  // entram aqui — `connection.connected` só flippa nesses 4 casos.
  if (!snap.connection.connected) {
    return (
      <div className="app">
        <div className="title-bar">
          <span className="title-bar-logo">
            <Logo size={18} />
          </span>
          Venda no Zap Print Agent
        </div>
        <ConnectScreen
          token={tokenInput}
          connecting={isConnecting}
          errorMessage={connectError}
          onTokenChange={(v) => {
            setTokenInput(v)
            if (connectError) setConnectError(null)
          }}
          onConnect={handleConnect}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="title-bar">
        <span className="title-bar-logo">
          <Logo size={18} />
        </span>
        Venda no Zap Print Agent
      </div>

      <header className="app-header">
        <Logo size={36} />
        <div className="header-text">
          <h1>Venda no Zap Print Agent</h1>
          <div className="subtitle">Impressão local de pedidos</div>
        </div>
      </header>

      <div className="status-bar">
        <span className={`status-dot status-${snap.status}`} aria-hidden />
        <span className="status-label">{STATUS_BAR_LABEL[snap.status]}</span>
        <span className="status-meta">
          {snap.connection.connected ? snap.connection.storeName : 'não conectado'}
        </span>
      </div>

      <main className="app-body">
        <ConnectionSection
          connected={snap.connection.connected}
          storeName={snap.connection.storeName}
          token={tokenInput}
          connecting={isConnecting}
          onTokenChange={setTokenInput}
          onReconnect={handleConnect}
          onDisconnect={() => {
            void window.printAgent.disconnect()
          }}
        />

        <PrinterSection
          config={snap.printer}
          testing={isTesting}
          onChange={async (next) => {
            const r = await window.printAgent.setPrinter(next)
            if (!r.ok) alert(`Não foi possível salvar a configuração: ${r.error}`)
          }}
          onTestPrint={async () => {
            if (isTesting) return
            setIsTesting(true)
            try {
              const result = await window.printAgent.testPrint()
              if (!result.ok) {
                const lines = [`Erro ao testar impressão: ${result.error}`]
                if (result.hint) lines.push('', result.hint)
                alert(lines.join('\n'))
              }
            } finally {
              setIsTesting(false)
            }
          }}
        />

        <HistorySection entries={snap.history} />

        <PreferencesSection
          prefs={snap.preferences}
          onChange={async (next) => {
            const r = await window.printAgent.setPreferences(next)
            if (!r.ok) alert(`Não foi possível salvar as preferências: ${r.error}`)
          }}
        />

        <LogsSection
          logs={snap.logs}
          onSendSupport={() => {
            window.open(buildSupportUrl(snap), '_blank', 'noopener,noreferrer')
          }}
        />
      </main>

      <footer className="footer">
        <span>v{snap.version}</span>
        <span>{snap.connection.connected ? 'Conectado' : 'Aguardando conexão'}</span>
      </footer>
    </div>
  )
}
