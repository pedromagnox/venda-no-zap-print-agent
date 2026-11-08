import { Switch } from '../Switch'
import type { InicioAutomatico, Preferences } from '@shared/types'

type PreferencesSectionProps = {
  prefs: Preferences
  inicioAutomatico?: InicioAutomatico | null
  onChange: (next: Preferences) => void
}

export function PreferencesSection({ prefs, inicioAutomatico, onChange }: PreferencesSectionProps): JSX.Element {
  const conhecido = !!inicioAutomatico && inicioAutomatico !== 'desconhecido'
  const ligado = conhecido
    ? inicioAutomatico === 'ligado' || inicioAutomatico === 'ligado_pela_politica'
    : prefs.autoStart
  const peloWindows = inicioAutomatico === 'desligado_pelo_usuario'
  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Preferências</span>
      </div>

      <Switch
        checked={ligado}
        onChange={(v) => onChange({ ...prefs, autoStart: v })}
        label="Iniciar com o Windows"
        hint={
          peloWindows
            ? 'Desligado nas configurações do Windows. Ao ligar aqui, abre a tela do Windows: ative «Venda no Zap Impressão».'
            : 'O agente sobe na bandeja ao ligar o PC.'
        }
      />
    </section>
  )
}
