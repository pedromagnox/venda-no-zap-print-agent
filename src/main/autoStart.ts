import { app } from 'electron'

// Wrapper sobre app.setLoginItemSettings com no-op em dev.
//
// Em dev (app.isPackaged === false), `setLoginItemSettings` registraria o
// electron.exe + caminho do projeto — comportamento útil pra ninguém. A
// preferência ainda é persistida no JSON, só não é aplicada no Windows.
//
// `--hidden` faz o app subir minimizado no tray quando o Windows inicia.
// O main checa `process.argv.includes('--hidden')` em createWindow().

export function applyAutoStart(autoStart: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: autoStart,
    args: ['--hidden']
  })
}

export function startedHidden(): boolean {
  return process.argv.includes('--hidden')
}
