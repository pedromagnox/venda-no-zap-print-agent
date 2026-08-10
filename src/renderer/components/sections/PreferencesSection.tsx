import { Switch } from '../Switch'
import type { Preferences } from '@shared/types'

type PreferencesSectionProps = {
  prefs: Preferences
  onChange: (next: Preferences) => void
}

export function PreferencesSection({ prefs, onChange }: PreferencesSectionProps): JSX.Element {
  return (
    <section className="section">
      <div className="section-header">
        <span className="section-title">Preferências</span>
      </div>

      <Switch
        checked={prefs.autoStart}
        onChange={(v) => onChange({ ...prefs, autoStart: v })}
        label="Iniciar com o Windows"
        hint="O agente sobe na bandeja ao ligar o PC."
      />

      <Switch
        checked={prefs.slowPrint}
        onChange={(v) => onChange({ ...prefs, slowPrint: v })}
        label="Minha impressora está imprimindo pela metade"
        hint="Envia o cupom em partes, mais devagar. Leva alguns segundos a mais."
      />
    </section>
  )
}
