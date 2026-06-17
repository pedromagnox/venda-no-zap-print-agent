import { useEffect, useState } from 'react'
import { Logo } from './Logo'
import type {
  PaperWidth,
  PrinterConfig,
  PrinterType,
  PrintMode,
  SpoolerPrinterInfo,
  SpoolerStatus
} from '@shared/types'

type Props = {
  config: PrinterConfig
  testing: boolean
  printMode?: PrintMode
  printerDriver?: string | null
  onChange: (next: PrinterConfig) => void
  onTestPrint: () => void
  onContinue: () => void
}

const TYPES: { value: PrinterType; label: string; pill: 'recommended' | 'advanced' }[] = [
  { value: 'windows_spooler', label: 'Windows', pill: 'recommended' },
  { value: 'network', label: 'Rede', pill: 'advanced' }
]

const WIDTHS: PaperWidth[] = [58, 80]

// Bate com `isPrinterConfigured` em App.tsx — fonte única de "tá pronto".
function configured(c: PrinterConfig): boolean {
  if (c.type === 'windows_spooler') return !!(c.spoolerName ?? '').trim()
  if (c.type === 'network') return !!(c.host ?? '').trim()
  return false
}

export function PrinterOnboardingScreen({
  config,
  testing,
  printMode = 'escpos',
  printerDriver = null,
  onChange,
  onTestPrint,
  onContinue
}: Props): JSX.Element {
  const [spoolerList, setSpoolerList] = useState<SpoolerPrinterInfo[]>([])
  const [spoolerLoading, setSpoolerLoading] = useState(false)

  const loadSpooler = async (): Promise<void> => {
    setSpoolerLoading(true)
    try {
      setSpoolerList(await window.printAgent.listSpoolerPrinters())
    } finally {
      setSpoolerLoading(false)
    }
  }

  useEffect(() => {
    if (config.type === 'windows_spooler') void loadSpooler()
  }, [config.type])

  const isConfigured = configured(config)

  return (
    <div className="printer-onboarding">
      <div className="printer-onboarding-hero">
        <Logo size={48} />
        <h1>Configure sua impressora</h1>
        <p>Selecione abaixo a impressora que vai receber os pedidos.</p>
      </div>

      <div className="printer-onboarding-card">
        {printMode === 'compatibility' && (
          <div className="compat-badge" role="status">
            Driver da impressora ausente. <strong>Modo de Compatibilidade</strong> ativado
            {printerDriver && (
              <span className="compat-badge-driver"> (driver: {printerDriver})</span>
            )}
          </div>
        )}

        <div className="field">
          <label className="label">Tipo de conexão</label>
          <div className="radio-group" role="radiogroup">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={config.type === t.value}
                className={`radio-card ${config.type === t.value ? 'active' : ''}`}
                onClick={() => onChange({ ...config, type: t.value })}
              >
                <span>{t.label}</span>
                <span className={`${t.pill}-pill`}>
                  {t.pill === 'recommended' ? 'recomendado' : 'avançado'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {config.type === 'windows_spooler' && (
          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className="label">Impressora instalada no Windows</label>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                onClick={() => void loadSpooler()}
                disabled={spoolerLoading}
              >
                {spoolerLoading ? 'buscando…' : 'atualizar'}
              </button>
            </div>
            <select
              className="select"
              value={config.spoolerName ?? ''}
              onChange={(e) => onChange({ ...config, spoolerName: e.target.value })}
            >
              <option value="">— Selecione —</option>
              {spoolerList.map((p) => (
                <option key={p.name} value={p.name}>
                  {formatSpoolerOption(p)}
                </option>
              ))}
            </select>
            {spoolerList.length === 0 && !spoolerLoading && (
              <div className="field-hint">
                Nenhuma impressora encontrada. Instale o driver do fabricante em
                Painel de Controle &gt; Dispositivos e Impressoras.
              </div>
            )}
            <SpoolerSelectedWarnings
              selected={spoolerList.find((p) => p.name === config.spoolerName)}
            />
          </div>
        )}

        {config.type === 'network' && (
          <div className="field">
            <label className="label">Endereço da impressora</label>
            <div className="field-row">
              <input
                className="input"
                placeholder="192.168.0.100"
                value={config.host ?? ''}
                onChange={(e) => onChange({ ...config, host: e.target.value })}
                spellCheck={false}
              />
              <input
                className="input"
                placeholder="9100"
                type="number"
                value={config.port ?? 9100}
                onChange={(e) => onChange({ ...config, port: Number(e.target.value) || 9100 })}
              />
            </div>
            <div className="field-hint">
              IP fixo da impressora térmica na rede (Wi-Fi ou Ethernet). Porta 9100 é o padrão ESC/POS.
            </div>
          </div>
        )}

        <div className="field">
          <label className="label">Largura do papel</label>
          <div className="radio-group" role="radiogroup">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={config.paperWidth === w}
                className={`radio-card ${config.paperWidth === w ? 'active' : ''}`}
                onClick={() => onChange({ ...config, paperWidth: w })}
              >
                {w} mm
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-block"
          onClick={onTestPrint}
          disabled={testing || !isConfigured}
        >
          {testing ? 'Testando…' : 'Testar impressão'}
        </button>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={onContinue}
          disabled={!isConfigured}
        >
          Continuar
        </button>

        {isConfigured && (
          <p className="printer-onboarding-tip">
            Recomendamos testar a impressão antes de continuar.
          </p>
        )}
      </div>
    </div>
  )
}

function formatSpoolerOption(p: SpoolerPrinterInfo): string {
  const parts: string[] = [p.name]
  if (p.isDefault) parts.push('(padrão)')
  const tag = statusTag(p.status)
  if (tag) parts.push(tag)
  else if (p.suspiciousPort) parts.push('⚠️ porta suspeita')
  return parts.join('  ')
}

function statusTag(status: SpoolerStatus): string {
  switch (status) {
    case 'error':
      return '⚠️ erro'
    case 'offline':
      return '⚠️ offline'
    case 'paper-out':
      return '⚠️ sem papel'
    case 'warning':
      return '⚠️ atenção'
    default:
      return ''
  }
}

function SpoolerSelectedWarnings({
  selected
}: {
  selected?: SpoolerPrinterInfo
}): JSX.Element | null {
  if (!selected) return null
  const problems: string[] = []
  if (selected.status === 'error') problems.push('A impressora está em estado de erro.')
  if (selected.status === 'offline') problems.push('A impressora está offline.')
  if (selected.status === 'paper-out') problems.push('A impressora está sem papel.')
  if (selected.status === 'warning') problems.push('A impressora reportou um problema.')
  if (selected.suspiciousPort) {
    problems.push(
      `A porta configurada é "${selected.portName}" — incomum pra USB. Em Painel de Controle → ` +
        `Dispositivos e Impressoras → propriedades, troque pra USB001 (ou similar).`
    )
  }
  if (problems.length === 0) return null
  return (
    <div className="field-hint" style={{ color: 'var(--color-error)', marginTop: 6 }}>
      {problems.map((p, i) => (
        <div key={i}>{p}</div>
      ))}
    </div>
  )
}
