// Fotos da lista «Encontradas neste computador» (v1.12.0) no app de verdade,
// em xvfb, com a lista FALSA do semFila.ts (PRINT_AGENT_FAKE_SEM_FILA=1, que só
// vale fora do Windows). Não vai no instalador.
//
// Antes: o better-sqlite3 com o prebuild linux (ver teste-real.mjs) e
// `npx electron-vite build`.
// Rodar: node scripts/foto-sem-fila.mjs <pasta de saída>
// Portas: 4401 (servidor falso), 9335 (DevTools).
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(REPO, 'package.json'))
const WebSocket = require('ws')
const OUT = path.resolve(process.argv[2] ?? '.')
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'print-agent-foto-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0]
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url === '/api/print-agent/token/exchange')
      return json({ accessToken: 'at', expiresIn: 3600, store: { id: '11111111-1111-4111-8111-111111111111', name: 'Loja Teste' } })
    if (url === '/api/print-queue/claim-lease' || url === '/api/print-queue') return json({ items: [] })
    return json({ ok: true })
  })
})
const wss = new WebSocket.WebSocketServer({ noServer: true })
server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => ws.send('{"type":"connected"}')))
await new Promise((r) => server.listen(4401, '127.0.0.1', r))

const app = spawn(
  'xvfb-run',
  ['-a', '-s', '-screen 0 1280x900x24', path.join(REPO, 'node_modules/electron/dist/electron'), REPO,
    '--remote-debugging-port=9335', '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: CFG,
      PRINT_AGENT_USE_MOCK: '0',
      PRINT_AGENT_FAKE_SEM_FILA: '1',
      PRINT_AGENT_API_BASE_URL: 'http://127.0.0.1:4401',
      PRINT_AGENT_WS_URL: 'ws://127.0.0.1:4401/api/print-agent/ws'
    }
  }
)

async function pagina() {
  for (let i = 0; i < 60; i++) {
    try {
      const lista = await (await fetch('http://127.0.0.1:9335/json/list')).json()
      const p = lista.find((x) => x.type === 'page')
      if (p) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('sem página no DevTools')
}

let seq = 0
async function cdp(method, params = {}) {
  const ws = new WebSocket(await pagina())
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)))
  const id = ++seq
  const resp = await new Promise((r) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.id === id) r(m)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.close()
  if (resp.error) throw new Error(JSON.stringify(resp.error))
  return resp.result
}
const evalTela = async (expression) =>
  (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
async function foto(nome) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  const f = path.join(OUT, nome)
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
  console.log('foto:', f)
}

try {
  await sleep(4000)
  console.log('connect →', JSON.stringify(await evalTela("window.printAgent.connect('vnzpa_teste_foto')")))
  await evalTela("window.printAgent.setPrinter({ type: 'windows_spooler', spoolerName: '', paperWidth: 58 })")
  await sleep(7000)
  await foto('1-lista.png')
  const clicou = await evalTela(
    "(() => { const b = [...document.querySelectorAll('.sem-fila-item button')][0]; if (!b) return false; b.click(); return true })()"
  )
  console.log('clicou em «Usar esta»:', clicou)
  await sleep(400)
  await foto('2-criando.png')
  await sleep(2500)
  await foto('3-depois.png')
  const snap = await evalTela('window.printAgent.getSnapshot()')
  console.log('impressora escolhida:', JSON.stringify(snap.printer))
  console.log('logs:', snap.logs.slice(0, 5).map((l) => l.message))
} catch (err) {
  console.error('FALHOU:', err)
  process.exitCode = 1
} finally {
  try {
    process.kill(-app.pid, 'SIGKILL')
  } catch {}
  server.close()
  fs.rmSync(CFG, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
