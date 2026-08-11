import { Switch } from '../Switch'
import type { Preferences, PrintModeSelection } from '@shared/types'

type PreferencesSectionProps = {
  prefs: Preferences
  /** Escolha do wizard (`printer.printMode`). `undefined` = nunca escolheu:
   *  quem manda é o servidor, e pode ser raster. */
  selectedMode?: PrintModeSelection
  onChange: (next: Preferences) => void
}

// O fatiamento só tem efeito em cupom raster — nos modos de texto o payload
// é pequeno e o splitter nem corta. Escondemos o toggle quando o modo é
// comprovadamente texto (toggle que não faz nada faz o lojista achar que o
// app quebrou), mas mantemos quando não há escolha local: foi assim que a
// loja do caso 09/08 imprimiu em raster, por `pdvSettings.rasterPrint` do
// servidor, sem nunca ter passado pelo wizard.
function slowPrintApplies(mode: PrintModeSelection | undefined): boolean {
  return mode === 'raster' || mode == null
}

export function PreferencesSection({
  prefs,
  selectedMode,
  onChange
}: PreferencesSectionProps): JSX.Element {
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

      {slowPrintApplies(selectedMode) && (
        <Switch
          checked={prefs.slowPrint}
          onChange={(v) => onChange({ ...prefs, slowPrint: v })}
          label="Minha impressora está imprimindo pela metade"
          hint="Envia o cupom em partes, mais devagar. Leva alguns segundos a mais."
        />
      )}
    </section>
  )
}
