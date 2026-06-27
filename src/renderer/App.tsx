import { useEffect, useState } from 'react'
import { Logo } from './components/Logo'
import { ConnectScreen } from './components/ConnectScreen'
import { PrinterOnboardingScreen } from './components/PrinterOnboardingScreen'
import { PrintModeWizard } from './components/PrintModeWizard'
import { PrinterSection } from './components/sections/PrinterSection'
import { HistorySection } from './components/sections/HistorySection'
import { LogsSection } from './components/sections/LogsSection'
import { ConnectionSection } from './components/sections/ConnectionSection'
import { PreferencesSection } from './components/sections/PreferencesSection'
import type { AgentSnapshot, PrinterConfig } from '@shared/types'

// "Configurada" = tem alvo selecionado (spooler name ou host de rede). Largura
// não conta como pendência — sempre tem default 80mm. Fonte única usada tanto
// pelo gate de onboarding (App) quanto pelo bloqueio do botão Continuar
// (PrinterOnboardingScreen).
function isPrinterConfigured(p: PrinterConfig): boolean {
  if (p.type === 'windows_spooler') return !!(p.spoolerName ?? '').trim()
  if (p.type === 'network') return !!(p.host ?? '').trim()
  return false
}

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
  if (snap.connection.storeId) {
    lines.push(`id da Loja: ${snap.connection.storeId}`)
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
  const [connectError, setConnectError] = useState<string | null>(null)
  // Onboarding da impressora: aparece quando o usuário conecta e ainda não
  // tem impressora válida. Após clicar "Continuar" essa flag fica true até
  // a sessão (app) reiniciar — evita prender o user em loop se ele tornar a
  // impressora inválida depois (raro). A flag reseta automaticamente quando
  // a conexão cai (refresh-rejected / logout).
  const [printerOnboardingDone, setPrinterOnboardingDone] = useState(false)
  // Wizard de modo de impressão: forceWizard = re-teste manual; wizardClosed =
  // o usuário concluiu/saiu (evita re-montar antes do snapshot atualizar);
  // reselecting = forçar a tela de seleção de impressora (escape do wizard).
  const [forceWizard, setForceWizard] = useState(false)
  const [wizardClosed, setWizardClosed] = useState(false)
  const [reselecting, setReselecting] = useState(false)
  useEffect(() => {
    if (!snap?.connection.connected) {
      setPrinterOnboardingDone(false)
      setForceWizard(false)
      setWizardClosed(false)
      setReselecting(false)
    }
  }, [snap?.connection.connected])

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

  const handleSetPrinter = async (next: PrinterConfig) => {
    // Trocar o ALVO da impressora invalida o modo testado → limpa o printMode e
    // reabre o wizard. Mudar só a largura preserva o modo.
    const targetChanged =
      next.type !== snap.printer.type ||
      (next.spoolerName ?? '') !== (snap.printer.spoolerName ?? '') ||
      (next.host ?? '') !== (snap.printer.host ?? '')
    const toSave: PrinterConfig = targetChanged ? { ...next, printMode: undefined } : next
    if (targetChanged) setWizardClosed(false)
    const r = await window.printAgent.setPrinter(toSave)
    if (!r.ok) alert(`Não foi possível salvar a configuração: ${r.error}`)
  }
  const handleTestPrint = async () => {
    if (isTesting) return
    setIsTesting(true)
    try {
      const result = await window.printAgent.testPrint()
      if (!result.ok) {
        const lines = [`Erro ao testar impressão: ${result.error}`]
        if (result.hint) lines.push('', result.hint)
        alert(lines.join('\n'))
      } else {
        alert('Impressão de teste enviada. Confira o papel saindo da impressora.')
      }
    } finally {
      setIsTesting(false)
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

  // Onboarding focado da impressora. Após conectar, se ainda não tem
  // impressora válida (spoolerName/host vazio), bloqueia até configurar e
  // clicar Continuar. Resetada quando desconecta.
  if (reselecting || (!printerOnboardingDone && !isPrinterConfigured(snap.printer))) {
    return (
      <div className="app">
        <div className="title-bar">
          <span className="title-bar-logo">
            <Logo size={18} />
          </span>
          Venda no Zap Print Agent
        </div>
        <PrinterOnboardingScreen
          config={snap.printer}
          testing={isTesting}
          printMode={snap.printMode}
          printerDriver={snap.printerDriver}
          onChange={handleSetPrinter}
          onTestPrint={handleTestPrint}
          onContinue={() => {
            setReselecting(false)
            setPrinterOnboardingDone(true)
          }}
        />
      </div>
    )
  }

  // Wizard de teste guiado de modo de impressão. Aparece quando há impressora
  // mas ainda sem modo escolhido (ou no re-teste manual). Concluir grava o
  // printMode na config → o gate fecha sozinho.
  const showWizard =
    !wizardClosed && isPrinterConfigured(snap.printer) && (!snap.printer.printMode || forceWizard)
  if (showWizard) {
    return (
      <div className="app">
        <div className="title-bar">
          <span className="title-bar-logo">
            <Logo size={18} />
          </span>
          Venda no Zap Print Agent
        </div>
        <PrintModeWizard
          onPrintTest={(mode) => window.printAgent.printTestReceipt(mode)}
          onSelectMode={(mode) => handleSetPrinter({ ...snap.printer, printMode: mode })}
          onDone={() => {
            setForceWizard(false)
            setWizardClosed(true)
          }}
          onSupport={() => window.open(buildSupportUrl(snap), '_blank', 'noopener,noreferrer')}
          onChangePrinter={() => {
            setForceWizard(false)
            setReselecting(true)
          }}
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

      <main className="app-body">
        <ConnectionSection
          connected={snap.connection.connected}
          storeName={snap.connection.storeName}
          status={snap.status}
          statusLabel={STATUS_BAR_LABEL[snap.status]}
          statusMessage={snap.statusMessage}
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
          printMode={snap.printMode}
          printerDriver={snap.printerDriver}
          onChange={handleSetPrinter}
          onTestPrint={handleTestPrint}
          onRetestMode={() => {
            setWizardClosed(false)
            setForceWizard(true)
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
