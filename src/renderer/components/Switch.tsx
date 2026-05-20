type SwitchProps = {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
}

export function Switch({ checked, onChange, label, hint }: SwitchProps): JSX.Element {
  return (
    <div className="switch-row">
      <div>
        <div className="switch-label">{label}</div>
        {hint && <div className="switch-hint">{hint}</div>}
      </div>
      <button
        type="button"
        className={`switch ${checked ? 'on' : ''}`}
        aria-pressed={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  )
}
