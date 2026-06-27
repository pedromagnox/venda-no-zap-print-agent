import { useEffect, useState } from 'react'
import type {
  PaperWidth,
  PrinterConfig,
  PrinterType,
  PrintMode,
  SpoolerPrinterInfo,
  SpoolerStatus
} from '@shared/types'

type PrinterSectionProps = {
  config: PrinterConfig
  testing?: boolean
  /** Modo de impressão detectado pelo main (vem do AgentSnapshot). */
  printMode?: PrintMode
  /** Nome do driver Windows da impressora atual, quando disponível. */
  printerDriver?: string | null
  onChange: (next: PrinterConfig) => void
  onTestPrint: () => void
  /** Abre o wizard de teste guiado de modo de impressão (re-teste). */
  onRetestMode?: () => void
}

const TYPES: { value: PrinterType; label: string; pill: 'recommended' | 'advanced' }[] = [
  { value: 'windows_spooler', label: 'Windows', pill: 'recommended' },
  { value: 'network', label: 'Rede', pill: 'advanced' }
]

const WIDTHS: PaperWidth[] = [58, 80]

// v1.10.0: detecta erros comuns no input de impressora de rede ANTES do
// connect. Origem: caso jun/2026 onde um lojista digitou "174919869" (IP
// sem pontos), o Node tentou resolver como hostname e logou DNS_FAIL com
// uma string numérica incompreensível.
function describeHostIssue(rawHost: string | undefined | null): string | null {
  const host = (rawHost ?? '').trim()
  if (!host) return null // vazio é OK — usuário ainda não digitou
  // String com >=8 dígitos sem ponto/dois-pontos/letra é IP sem pontos:
  // o caso clássico do "digitou tudo grudado".
  if (/^\d{8,}$/.test(host)) {
    return 'Parece um IP sem os pontos. Use o formato 192.168.0.100.'
  }
  // Tenta IPv4 estrito (cada octeto 0-255)
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const octs = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((s) => Number(s))
    if (octs.some((n) => n < 0 || n > 255)) {
      return 'IP inválido — cada parte deve estar entre 0 e 255.'
    }
    return null
  }
  // Hostname/mDNS: letras, dígitos, hífen, ponto. Tolerante o suficiente
  // pra aceitar "impressora.local", "pos-58.local", "minhaloja-printer".
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
    return null
  }
  return 'Formato inválido. Use um IP (192.168.0.100) ou nome de host (impressora.local).'
}

export function PrinterSection({
  config,
  testing = false,
  printMode = 'escpos',
  printerDriver = null,
  onChange,
  onTestPrint,
  onRetestMode
}: PrinterSectionProps): JSX.Element {
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

  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Impressora</span>
      </div>

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

      {config.type === 'network' && (() => {
        const hostIssue = describeHostIssue(config.host)
        return (
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
              Use se sua impressora térmica tem IP fixo na rede (Wi-Fi ou Ethernet).
              Porta 9100 é o padrão ESC/POS.
            </div>
            {hostIssue && (
              <div className="field-hint" style={{ color: '#b45309', marginTop: 6 }}>
                ⚠ {hostIssue}
              </div>
            )}
          </div>
        )
      })()}

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
        className="btn btn-primary btn-block"
        onClick={onTestPrint}
        disabled={testing}
      >
        {testing ? 'Testando…' : 'Testar impressão'}
      </button>

      {onRetestMode && (
        <button type="button" className="btn btn-block" onClick={onRetestMode}>
          Configurar modo de impressão
        </button>
      )}
    </section>
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
