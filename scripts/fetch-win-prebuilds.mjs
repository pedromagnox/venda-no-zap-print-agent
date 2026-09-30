// Baixa o prebuild win32-x64 do better-sqlite3 pro Electron em uso.
//
// Necessário pro build na VPS (Linux): lá o node_modules nunca passa pelo
// `electron:rebuild` (que só roda no Windows), e com `npmRebuild: false` o
// electron-builder empacota o que estiver em build/Release — sem este passo,
// iria o .node de Linux (ou nenhum). O @thesusheer/electron-printer não
// precisa: o .node win32-x64 já vem dentro do pacote npm.
//
// No Windows continua valendo o fluxo antigo (electron:rebuild) — rodar este
// script lá é inofensivo, só troca o binário pelo mesmo prebuild oficial.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronVersion = require('electron/package.json').version
const sqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'))
const bin = path.resolve('node_modules', '.bin', 'prebuild-install')
// Build legado: sai em 64 E 32 bits (PC com Windows 8.1 de 32 bits existe).
// Cada arquitetura precisa do .node dela — o electron-builder está com
// npmRebuild:false, então empacota o que estiver em build/Release.
const arch = process.argv[2] === 'ia32' ? 'ia32' : 'x64'

console.log(`better-sqlite3: baixando prebuild win32-${arch} pro Electron ${electronVersion}...`)
execFileSync(
  bin,
  ['--platform=win32', `--arch=${arch}`, '--runtime=electron', `--target=${electronVersion}`],
  { cwd: sqliteDir, stdio: 'inherit' }
)
console.log(`ok: build/Release/better_sqlite3.node é win32-${arch}`)
