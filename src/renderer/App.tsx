import { useEffect, useState, type CSSProperties } from 'react'
import { Logo } from './components/Logo'
import { ConnectScreen } from './components/ConnectScreen'
import { PrinterOnboardingScreen } from './components/PrinterOnboardingScreen'
import { PrintModeWizard } from './components/PrintModeWizard'
import { PrinterSection } from './components/sections/PrinterSection'
import { HistorySection } from './components/sections/HistorySection'
import { LogsSection } from './components/sections/LogsSection'
import { ConnectionSection } from './components/sections/ConnectionSection'
import { PreferencesSection } from './components/sections/PreferencesSection'
import { AvisosDoWindows } from './components/AvisosDoWindows'
import {
  CHAVE_PRINCIPAL,
  MAXIMO_DE_IMPRESSORAS,
  alvoDaImpressora,
  configDaImpressora,
  corDaImpressora,
  nomeDeFabrica,
  type AgentSnapshot,
  type PrinterConfig
} from '@shared/types'
import { isPrinterConfigured } from './lib/printerConfig'

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
  // v1.11.0: pode haver mais de uma loja nesta instalação — o suporte precisa
  // de TODOS os ids, senão investiga a loja errada.
  if (snap.stores.length === 1) {
    lines.push(`id da Loja: ${snap.stores[0]!.storeId}`)
  } else if (snap.stores.length > 1) {
    lines.push(`Lojas conectadas (${snap.stores.length}):`)
    for (const s of snap.stores) lines.push(`  - ${s.storeName}: ${s.storeId}`)
  } else if (snap.connection.storeId) {
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
  const [testandoChave, setTestandoChave] = useState<string | null>(null)
  const isTesting = testandoChave !== null
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
  const [chaveDoWizard, setChaveDoWizard] = useState<string>(CHAVE_PRINCIPAL)
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

  const impressoras = [{ chave: CHAVE_PRINCIPAL }, ...snap.extras].map((i, posicao) => ({
    chave: i.chave,
    nome: snap.nomesDasImpressoras[i.chave] ?? nomeDeFabrica(posicao),
    cor: corDaImpressora(snap.extras, i.chave),
    alvo: alvoDaImpressora(configDaImpressora(snap, i.chave))
  }))
  const emUsoForaDe = (chave: string): Record<string, string> =>
    Object.fromEntries(impressoras.filter((i) => i.chave !== chave && i.alvo).map((i) => [i.alvo!, i.nome]))
  // «Encontradas neste computador» aparece num cartão só: o primeiro sem impressora escolhida (ou a principal).
  const chaveDasEncontradas =
    impressoras.find((i) => !isPrinterConfigured(configDaImpressora(snap, i.chave)))?.chave ?? CHAVE_PRINCIPAL

  const handleSetPrinter = async (next: PrinterConfig, chave: string = CHAVE_PRINCIPAL) => {
    // Trocar o ALVO da impressora invalida o modo testado → limpa o printMode e
    // reabre o wizard. Mudar só a largura preserva o modo.
    const antes = configDaImpressora(snap, chave)
    const targetChanged =
      next.type !== antes.type ||
      (next.spoolerName ?? '') !== (antes.spoolerName ?? '') ||
      (next.host ?? '') !== (antes.host ?? '')
    const toSave: PrinterConfig = targetChanged ? { ...next, printMode: undefined } : next
    if (targetChanged && chave === CHAVE_PRINCIPAL) setWizardClosed(false)
    const r = await window.printAgent.setPrinter(toSave, chave)
    if (!r.ok) alert(`Não foi possível salvar a configuração: ${r.error}`)
    if (targetChanged && chave !== CHAVE_PRINCIPAL && isPrinterConfigured(toSave)) {
      setChaveDoWizard(chave)
      setWizardClosed(false)
      setForceWizard(true)
    }
  }
  const handleTestPrint = async (chave: string = CHAVE_PRINCIPAL) => {
    if (isTesting) return
    setTestandoChave(chave)
    try {
      const result = await window.printAgent.testPrint(chave)
      if (!result.ok) {
        const lines = [`Erro ao testar impressão: ${result.error}`]
        if (result.hint) lines.push('', result.hint)
        alert(lines.join('\n'))
      } else {
        alert('Impressão de teste enviada. Confira o papel saindo da impressora.')
      }
    } finally {
      setTestandoChave(null)
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
          onChange={(next) => handleSetPrinter(next, CHAVE_PRINCIPAL)}
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
  const chaveWizard = forceWizard ? chaveDoWizard : CHAVE_PRINCIPAL
  const configWizard = configDaImpressora(snap, chaveWizard)
  const showWizard =
    !wizardClosed && isPrinterConfigured(configWizard) && (!configWizard.printMode || forceWizard)
  if (showWizard) {
    return (
      <div className="app">
        <div className="title-bar">
          <span className="title-bar-logo">
            <Logo size={18} />
          </span>
          Venda no Zap Print Agent
        </div>
        <div
          style={{ display: 'contents', '--brand-primary': corDaImpressora(snap.extras, chaveWizard) } as CSSProperties}
        >
          <PrintModeWizard
            onPrintTest={(mode) => window.printAgent.printTestReceipt(mode, chaveWizard)}
            podeUsarDriver={configWizard.type === 'windows_spooler'}
            onSelectMode={(mode) => handleSetPrinter({ ...configWizard, printMode: mode }, chaveWizard)}
            onDone={() => {
              setForceWizard(false)
              setWizardClosed(true)
            }}
            onSupport={() => window.open(buildSupportUrl(snap), '_blank', 'noopener,noreferrer')}
            onChangePrinter={() => {
              setForceWizard(false)
              setReselecting(true)
            }}
            onSkip={() => {
              setForceWizard(false)
              setWizardClosed(true)
            }}
          />
        </div>
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
        <AvisosDoWindows
          estado={snap.windowsStore}
          onLigarInicio={async () => {
            const r = await window.printAgent.setPreferences({ ...snap.preferences, autoStart: true })
            if (!r.ok) alert(`Não foi possível salvar as preferências: ${r.error}`)
          }}
          onAbrirAplicativos={() => {
            void window.printAgent.abrirConfiguracaoDoWindows('aplicativos')
          }}
        />

        <ConnectionSection
          stores={snap.stores}
          status={snap.status}
          statusLabel={STATUS_BAR_LABEL[snap.status]}
          statusMessage={snap.statusMessage}
          token={tokenInput}
          connecting={isConnecting}
          onTokenChange={setTokenInput}
          onReconnect={handleConnect}
          onDisconnectStore={(storeId) => {
            void window.printAgent.disconnectStore(storeId)
          }}
        />

        {impressoras.map((imp) => (
          <PrinterSection
            key={imp.chave}
            config={configDaImpressora(snap, imp.chave)}
            testing={testandoChave === imp.chave}
            printMode={imp.chave === CHAVE_PRINCIPAL ? snap.printMode : undefined}
            printerDriver={imp.chave === CHAVE_PRINCIPAL ? snap.printerDriver : null}
            onChange={(next) => handleSetPrinter(next, imp.chave)}
            onTestPrint={() => handleTestPrint(imp.chave)}
            onRetestMode={() => {
              setChaveDoWizard(imp.chave)
              setWizardClosed(false)
              setForceWizard(true)
            }}
            nome={imp.nome}
            cor={imp.cor}
            emUso={emUsoForaDe(imp.chave)}
            mostrarEncontradas={imp.chave === chaveDasEncontradas}
            onRenomear={async (nome) => {
              const r = await window.printAgent.renomearImpressora(imp.chave, nome)
              return r.ok ? null : (r.error ?? 'Não deu para trocar o nome.')
            }}
            onRemover={
              imp.chave === CHAVE_PRINCIPAL
                ? undefined
                : async () => {
                    if (!confirm(`Remover a impressora «${imp.nome}» deste computador?`)) return
                    const r = await window.printAgent.removerImpressora(imp.chave)
                    if (!r.ok) alert(r.error ?? 'Não deu para remover a impressora.')
                  }
            }
          />
        ))}

        {impressoras.length < MAXIMO_DE_IMPRESSORAS ? (
          <button
            type="button"
            className="btn btn-block btn-adicionar"
            onClick={async () => {
              const r = await window.printAgent.adicionarImpressora()
              if (!r.ok) alert(r.error ?? 'Não deu para adicionar a impressora.')
            }}
          >
            + Adicionar impressora
          </button>
        ) : (
          <div className="field-hint limite-impressoras">Máximo de {MAXIMO_DE_IMPRESSORAS} impressoras neste computador.</div>
        )}

        <HistorySection entries={snap.history} />

        <PreferencesSection
          prefs={snap.preferences}
          inicioAutomatico={snap.windowsStore?.inicioAutomatico ?? null}
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
