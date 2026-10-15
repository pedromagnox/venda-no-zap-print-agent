// Teste de verdade do app (Electron em xvfb, na VPS) contra um servidor falso:
// boot sem internet, campainha muda com o WebSocket conectado e suspensão sem
// o aviso de retomada. Não vai no instalador.
//
// Antes: trocar o better-sqlite3 pelo prebuild linux do Electron em uso:
//   cd node_modules/better-sqlite3 && ../.bin/prebuild-install --platform=linux --arch=x64 --runtime=electron --target=<versão do electron>
// e `npx electron-vite build`. O `npm run dist:win:vps` volta o win32 sozinho.
// Rodar: node scripts/teste-real.mjs <pasta do app> <rótulo> [--contraste]
// Portas: 4400 (servidor), 9101 (impressora), 9333/9334 (DevTools).
//
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(REPO, 'package.json'))
const WebSocket = require('ws')

const APP_DIR = process.argv[2]
const ROTULO = process.argv[3] ?? 'app'
const CONTRASTE = process.argv.includes('--contraste')
const SCRATCH = os.tmpdir()
const CFG = path.join(SCRATCH, `print-agent-teste-real-${ROTULO}`)
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(CFG, { recursive: true })

const T0 = Date.now()
const t = () => `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`
const log = (...a) => console.log(t(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- impressora falsa (TCP 9101) ----------------
const impressos = []
net
  .createServer((sock) => {
    let n = 0
    sock.on('data', (d) => (n += d.length))
    sock.on('close', () => {
      impressos.push(Date.now())
      log(`🖨  IMPRESSORA: cupom recebido (${n} bytes)`)
    })
    sock.on('error', () => {})
  })
  .listen(9101, '127.0.0.1')

// ---------------- servidor falso (HTTP + WS em 4400) ----------------
const jobs = []
let seq = 0
const ev = { exchange: [], ping: [], claimComItens: [], ack: [], wsAbertos: [], wsFechados: [] }
const cupom = Buffer.from('\x1b@Pedido de teste\n\n\n\n\x1dV\x00', 'latin1').toString('base64')

function addJob(nota) {
  const id = `job-${++seq}`
  jobs.push({ id, status: 'pending', at: Date.now() })
  log(`📥 SERVIDOR: pedido ${id} entrou na fila SEM campainha (${nota})`)
  return id
}

function handler(req, res) {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0]
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url === '/api/print-agent/token/exchange') {
      ev.exchange.push(Date.now())
      log('🔑 SERVIDOR: troca de token — o app conectou')
      return json(200, {
        accessToken: `at-${ev.exchange.length}`,
        expiresIn: 3600,
        store: { id: '11111111-1111-4111-8111-111111111111', name: 'Loja Teste' }
      })
    }
    if (url === '/api/print-agent/ping') {
      ev.ping.push(Date.now())
      return json(200, { ok: true })
    }
    if (url === '/api/print-agent/telemetry') {
      try {
        const b = JSON.parse(body || '{}')
        if (b.type === 'agent_started') log('📈 SERVIDOR: telemetria agent_started')
      } catch {}
      return json(200, { ok: true, payloadVersion: 1 })
    }
    if (url === '/api/print-queue/claim-lease') {
      const items = jobs.filter((j) => j.status === 'pending').slice(0, 5)
      for (const j of items) j.status = 'leased'
      if (items.length) {
        ev.claimComItens.push(Date.now())
        log(`📤 SERVIDOR: claim-lease entregou ${items.map((j) => j.id).join(', ')}`)
      }
      return json(200, {
        items: items.map((j) => ({
          id: j.id,
          orderId: j.id,
          reason: 'new_order',
          bytesBase64: cupom,
          paperWidth: '58mm'
        }))
      })
    }
    let m
    if ((m = url.match(/^\/api\/print-queue\/([^/]+)\/ack$/))) {
      const j = jobs.find((x) => x.id === m[1])
      if (j) {
        j.status = 'acked'
        j.ackAt = Date.now()
      }
      ev.ack.push(Date.now())
      log(`✅ SERVIDOR: ack de ${m[1]} (${j ? ((j.ackAt - j.at) / 1000).toFixed(1) : '?'} s depois de entrar na fila)`)
      return json(200, { ok: true })
    }
    if ((m = url.match(/^\/api\/print-queue\/([^/]+)\/release$/))) {
      const j = jobs.find((x) => x.id === m[1])
      if (j) j.status = 'pending'
      log(`↩️  SERVIDOR: release de ${m[1]}: ${body}`)
      return json(200, { ok: true })
    }
    if (url === '/api/print-queue/test-receipt')
      return json(200, { mode: 'escpos', paperWidth: '58mm', bytesBase64: cupom })
    if (url === '/api/print-queue') return json(200, { items: [] })
    return json(404, { error: 'not found' })
  })
}

let server = null
const sockets = new Set()
const wsClients = new Set()
const wss = new WebSocket.WebSocketServer({ noServer: true })
wss.on('connection', (ws) => {
  wsClients.add(ws)
  ev.wsAbertos.push(Date.now())
  log('🔌 SERVIDOR: WebSocket do app conectou (a campainha fica MUDA neste teste)')
  ws.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }))
  ws.on('close', () => {
    wsClients.delete(ws)
    ev.wsFechados.push(Date.now())
    log('🔌 SERVIDOR: WebSocket do app desconectou')
  })
  ws.on('error', () => {})
})

function servidorNoAr() {
  return new Promise((resolve) => {
    server = http.createServer(handler)
    server.on('connection', (s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    server.on('upgrade', (req, sock, head) => {
      if ((req.url ?? '').startsWith('/api/print-agent/ws')) {
        wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req))
      } else sock.destroy()
    })
    server.listen(4400, '127.0.0.1', () => {
      log('🌐 SERVIDOR: no ar (internet "ligada")')
      resolve()
    })
  })
}

function servidorFora() {
  return new Promise((resolve) => {
    if (!server) return resolve()
    for (const ws of wsClients) ws.terminate()
    for (const s of sockets) s.destroy()
    server.close(() => {
      server = null
      log('🚫 SERVIDOR: fora do ar (internet "desligada": conexão recusada)')
      resolve()
    })
  })
}

// ---------------- app (Electron em xvfb) ----------------
let appProc = null
function abrirApp(nota) {
  const electron = path.join(REPO, 'node_modules/electron/dist/electron')
  appProc = spawn(
    'xvfb-run',
    [
      '-a',
      electron,
      APP_DIR,
      '--remote-debugging-port=9333',
      '--inspect=9334',
      '--no-sandbox',
      '--password-store=basic',
      '--disable-gpu'
    ],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: CFG,
        PRINT_AGENT_USE_MOCK: '0',
        PRINT_AGENT_API_BASE_URL: 'http://127.0.0.1:4400',
        PRINT_AGENT_WS_URL: 'ws://127.0.0.1:4400/api/print-agent/ws'
      }
    }
  )
  appProc.stderr.on('data', () => {})
  log(`🚀 APP ${ROTULO}: aberto (${nota})`)
}

async function fecharApp() {
  if (!appProc) return
  const p = appProc
  appProc = null
  try {
    await mainEval("require('electron').app.quit()")
  } catch {}
  const saiu = await Promise.race([
    new Promise((r) => p.once('exit', () => r(true))),
    sleep(15_000).then(() => false)
  ])
  if (!saiu) {
    try {
      process.kill(-p.pid, 'SIGKILL')
    } catch {}
  }
  await sleep(1500)
  log(`🛑 APP ${ROTULO}: fechado`)
}

async function alvo(porta, tipo) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}/json/list`)
      const lista = await r.json()
      const a = lista.find((x) => (tipo ? x.type === tipo : true))
      if (a) return a.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error(`sem alvo CDP na porta ${porta}`)
}

async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  const resp = await new Promise((r) => {
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.id === 1) r(msg)
    })
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true }
      })
    )
  })
  ws.close()
  if (resp.result?.exceptionDetails) throw new Error(JSON.stringify(resp.result.exceptionDetails).slice(0, 300))
  return resp.result?.result?.value
}
const telaEval = async (expr) => cdpEval(await alvo(9333, 'page'), expr)
const mainEval = async (expr) => cdpEval(await alvo(9334), expr)

async function esperar(cond, ms) {
  const fim = Date.now() + ms
  while (Date.now() < fim) {
    if (cond()) return true
    await sleep(250)
  }
  return false
}

async function statusDaLoja() {
  try {
    const s = await telaEval('window.printAgent.getSnapshot()')
    return (s.stores ?? []).map((x) => `${x.status}: ${x.statusMessage}`).join(' | ')
  } catch (e) {
    return `(sem tela: ${e.message.slice(0, 80)})`
  }
}

async function ultimosLogs(n) {
  try {
    const s = await telaEval('window.printAgent.getSnapshot()')
    return (s.logs ?? []).slice(0, n).reverse().map((l) => `      ${l.time} [${l.level}] ${l.message}`)
  } catch {
    return []
  }
}

// ---------------- roteiro ----------------
const resultado = {}
async function main() {
  console.log(`\n===== ${ROTULO} (${APP_DIR}) =====`)

  // Preparação: conecta a loja e escolhe a impressora (fica salvo no userData).
  await servidorNoAr()
  abrirApp('preparação: conectar a loja e escolher a impressora')
  await sleep(4000)
  const c = await telaEval("window.printAgent.connect('vnzpa_teste_harness')")
  log(`   preparação: connect → ${JSON.stringify(c).slice(0, 120)}`)
  const p = await telaEval(
    "window.printAgent.setPrinter({ type: 'network', host: '127.0.0.1', port: 9101, paperWidth: 58, printMode: 'escpos' })"
  )
  log(`   preparação: setPrinter → ${JSON.stringify(p)}`)
  await esperar(() => ev.wsAbertos.length > 0, 15_000)
  await sleep(2000)
  await fecharApp()

  // ===== Cenário 1: o PC liga sem internet =====
  console.log('\n----- Cenário 1: boot sem internet (#206) -----')
  await servidorFora()
  const nEx = ev.exchange.length
  abrirApp('boot com a internet fora')
  await sleep(25_000)
  log(`   status na tela com a internet fora: ${await statusDaLoja()}`)
  const voltou = Date.now()
  await servidorNoAr()
  addJob('chegou enquanto o app estava sem conexão')
  const nImp1 = impressos.length
  const ok1 = await esperar(() => impressos.length > nImp1, 100_000)
  resultado.c1 = ok1
    ? `conectou ${((ev.exchange[nEx] - voltou) / 1000).toFixed(1)} s depois da internet voltar e imprimiu ${((impressos[nImp1] - voltou) / 1000).toFixed(1)} s depois`
    : `NÃO reconectou em 100 s com a internet de volta (trocas de token: ${ev.exchange.length - nEx})`
  log(`➡️  CENÁRIO 1: ${resultado.c1}`)
  log(`   status na tela: ${await statusDaLoja()}`)

  if (!ok1 && CONTRASTE) {
    await fecharApp()
    abrirApp('reaberto com a internet no ar — o que o lojista faz ao reinstalar')
    await esperar(() => impressos.length > nImp1, 60_000)
  }

  // ===== Cenário 2: WebSocket conectado, campainha muda =====
  console.log('\n----- Cenário 2: WebSocket conectado, aviso do pedido não chega -----')
  await esperar(() => wsClients.size > 0, 30_000)
  await sleep(8000)
  const j2 = addJob('o WebSocket está conectado, mas o aviso não vem')
  const t2 = Date.now()
  const nImp2 = impressos.length
  const ok2 = await esperar(() => impressos.length > nImp2, 100_000)
  resultado.c2 = ok2
    ? `a consulta de segurança pegou o pedido ${((impressos[nImp2] - t2) / 1000).toFixed(1)} s depois, sem campainha`
    : `o pedido ${j2} ficou PARADO 100 s na fila (nenhum claim)`
  log(`➡️  CENÁRIO 2: ${resultado.c2}`)

  // ===== Cenário 3: suspensão sem aviso de retomada =====
  console.log('\n----- Cenário 3: suspensão sem o aviso de retomada do Windows -----')
  await mainEval("require('electron').powerMonitor.emit('suspend'), 'ok'")
  const t3 = Date.now()
  log("💤 APP: powerMonitor 'suspend' emitido; o 'resume' e o 'unlock-screen' NUNCA vêm")
  await sleep(3000)
  const j3 = addJob('chegou depois da suspensão')
  const nImp3 = impressos.length
  const nPing3 = ev.ping.length
  const ok3 = await esperar(() => impressos.length > nImp3, 150_000)
  const pings = ev.ping.length - nPing3
  resultado.c3 = ok3
    ? `o vigia religou a busca: imprimiu ${((impressos[nImp3] - t3) / 1000).toFixed(1)} s depois da suspensão (pings no meio-tempo: ${pings})`
    : `o pedido ${j3} ficou PARADO 150 s com o ping vivo (pings no meio-tempo: ${pings})`
  log(`➡️  CENÁRIO 3: ${resultado.c3}`)

  console.log('\n----- Últimos logs do app -----')
  for (const l of await ultimosLogs(22)) console.log(l)

  await fecharApp()
  console.log(`\n===== RESUMO ${ROTULO} =====`)
  console.log(`  1. Boot sem internet: ${resultado.c1}`)
  console.log(`  2. Campainha muda:    ${resultado.c2}`)
  console.log(`  3. Suspensão:         ${resultado.c3}`)
  process.exit(0)
}

main().catch(async (e) => {
  console.error('FALHOU:', e)
  try {
    if (appProc) process.kill(-appProc.pid, 'SIGKILL')
  } catch {}
  process.exit(1)
})
