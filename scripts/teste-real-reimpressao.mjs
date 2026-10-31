// Teste de verdade do app (Electron em xvfb, na VPS) para os casos que a
// 1.11.3 ainda deixava passar (pergunta da sessão Atendente, 16/10):
//   1. suspensão no meio da reimpressão das pendentes do banco local, com o
//      'resume' chegando antes de ela terminar → a busca morria;
//   2. suspensão no meio de um pedido, com o 'resume' chegando antes de ele
//      sair → o recoverLocal reimprimia o mesmo pedido (cupom em dobro);
//   3. WebSocket cujo handshake nunca responde → o app nunca tentava de novo.
// Não vai no instalador. Pré-requisitos e portas: ver scripts/teste-real.mjs.
//
// Rodar: node scripts/teste-real-reimpressao.mjs <pasta do app> <rótulo>
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(REPO, 'package.json'))
const WebSocket = require('ws')

const APP_DIR = process.argv[2]
const ROTULO = process.argv[3] ?? 'app'
const CFG = path.join(os.tmpdir(), `print-agent-teste-reimpressao-${ROTULO}`)
fs.rmSync(CFG, { recursive: true, force: true })
fs.mkdirSync(CFG, { recursive: true })
const STORE_ID = '11111111-1111-4111-8111-111111111111'

const T0 = Date.now()
const t = () => `${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`
const log = (...a) => console.log(t(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Cupom grande (24 MB) para a impressora falsa conseguir segurar a impressão:
// o app só termina de imprimir quando o kernel drena os bytes, e a impressora
// pausa a leitura. O id do pedido vai no começo do cupom.
const GRANDE = 24 * 1024 * 1024
function cupom(id, grande) {
  const cab = Buffer.from(`\x1b@PEDIDO:${id}:\n`, 'latin1')
  return Buffer.concat([cab, Buffer.alloc(grande ? GRANDE : 64, 0x20)]).toString('base64')
}

// ---------------- impressora falsa (TCP 9101) ----------------
const impressoes = {} // id -> quantas vezes saiu
let segurar = null // { id, ms }: pausa a leitura desse pedido (o app fica imprimindo)
let impressaoAtual = null // { id, inicio }
net
  .createServer((sock) => {
    let cab = ''
    let id = null
    sock.on('data', (d) => {
      if (id !== null) return
      cab += d.subarray(0, 64).toString('latin1')
      const m = cab.match(/PEDIDO:([^:]+):/)
      if (!m) return
      id = m[1]
      impressaoAtual = { id, inicio: Date.now() }
      if (segurar && segurar.id === id) {
        const ms = segurar.ms
        segurar = null
        sock.pause()
        log(`🖨  IMPRESSORA: segurando a impressão de ${id} por ${ms / 1000} s`)
        setTimeout(() => sock.resume(), ms)
      }
    })
    sock.on('close', () => {
      if (id) {
        impressoes[id] = (impressoes[id] ?? 0) + 1
        log(`🖨  IMPRESSORA: saiu o cupom de ${id} (${impressoes[id]}ª vez)`)
      }
      impressaoAtual = null
    })
    sock.on('error', () => {})
  })
  .listen(9101, '127.0.0.1')

// ---------------- servidor falso (HTTP + WS em 4400) ----------------
const jobs = []
let seq = 0
let wsTravado = false
let upgrades = 0
const wsClients = new Set()

function addJob(nota, grande = false) {
  const id = `job-${++seq}`
  jobs.push({ id, status: 'pending', grande, at: Date.now() })
  log(`📥 SERVIDOR: pedido ${id} na fila (${nota})`)
  return id
}
function tocarCampainha() {
  for (const ws of wsClients) ws.send(JSON.stringify({ type: 'job', at: new Date().toISOString() }))
  log(`🔔 SERVIDOR: campainha tocada para ${wsClients.size} socket(s)`)
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
      log('🔑 SERVIDOR: troca de token')
      return json(200, { accessToken: 'at', expiresIn: 3600, store: { id: STORE_ID, name: 'Loja Teste' } })
    }
    if (url === '/api/print-agent/ping' || url === '/api/print-agent/telemetry') return json(200, { ok: true })
    if (url === '/api/print-queue/claim-lease') {
      const items = jobs.filter((j) => j.status === 'pending').slice(0, 5)
      for (const j of items) j.status = 'leased'
      if (items.length) log(`📤 SERVIDOR: claim-lease entregou ${items.map((j) => j.id).join(', ')}`)
      return json(200, {
        items: items.map((j) => ({ id: j.id, orderId: j.id, reason: 'new_order', bytesBase64: cupom(j.id, j.grande), paperWidth: '58mm' }))
      })
    }
    let m
    if ((m = url.match(/^\/api\/print-queue\/([^/]+)\/ack$/))) {
      const j = jobs.find((x) => x.id === m[1])
      if (j) j.status = 'acked'
      log(`✅ SERVIDOR: ack de ${m[1]}`)
      return json(200, { ok: true })
    }
    if ((m = url.match(/^\/api\/print-queue\/([^/]+)\/release$/))) {
      const j = jobs.find((x) => x.id === m[1])
      if (j) j.status = 'pending'
      log(`↩️  SERVIDOR: release de ${m[1]}`)
      return json(200, { ok: true })
    }
    if (url === '/api/print-queue/test-receipt') return json(200, { mode: 'escpos', bytesBase64: cupom('teste', false) })
    return json(404, {})
  })
}

const wss = new WebSocket.WebSocketServer({ noServer: true })
wss.on('connection', (ws) => {
  wsClients.add(ws)
  log('🔌 SERVIDOR: WebSocket conectou')
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('close', () => wsClients.delete(ws))
  ws.on('error', () => {})
})
const server = http.createServer(handler)
server.on('upgrade', (req, sock, head) => {
  upgrades++
  if (wsTravado) {
    log(`🔌 SERVIDOR: tentativa de WebSocket nº ${upgrades} — o servidor NÃO responde ao handshake`)
    sock.on('error', () => {})
    return // segura o socket sem responder
  }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req))
})
server.listen(4400, '127.0.0.1')

// ---------------- app (Electron em xvfb) ----------------
let appProc = null
function abrirApp(nota) {
  appProc = spawn(
    'xvfb-run',
    ['-a', path.join(REPO, 'node_modules/electron/dist/electron'), APP_DIR, '--remote-debugging-port=9333', '--inspect=9334', '--no-sandbox', '--password-store=basic', '--disable-gpu'],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: CFG,
        PRINT_AGENT_USE_MOCK: '0',
        PRINT_AGENT_API_BASE_URL: 'http://127.0.0.1:4400',
        PRINT_AGENT_WS_URL: 'ws://127.0.0.1:4400/api/print-agent/ws'
      }
    }
  )
  log(`🚀 APP ${ROTULO}: aberto (${nota})`)
}
async function fecharApp() {
  if (!appProc) return
  const p = appProc
  appProc = null
  try {
    await mainEval("require('electron').app.quit()")
  } catch {}
  const saiu = await Promise.race([new Promise((r) => p.once('exit', () => r(true))), sleep(15_000).then(() => false)])
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
      const lista = await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json()
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
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }))
  })
  ws.close()
  if (resp.result?.exceptionDetails) throw new Error(JSON.stringify(resp.result.exceptionDetails).slice(0, 300))
  return resp.result?.result?.value
}
const telaEval = async (e) => cdpEval(await alvo(9333, 'page'), e)
const mainEval = async (e) => cdpEval(await alvo(9334), e)
const powerMonitor = (ev) => mainEval(`require('electron').powerMonitor.emit('${ev}'), 'ok'`)
async function esperar(cond, ms) {
  const fim = Date.now() + ms
  while (Date.now() < fim) {
    if (cond()) return true
    await sleep(250)
  }
  return false
}
async function ultimosLogs(n) {
  try {
    const s = await telaEval('window.printAgent.getSnapshot()')
    return (s.logs ?? []).slice(0, n).reverse().map((l) => `      ${l.time} [${l.level}] ${l.message}`)
  } catch {
    return []
  }
}
function semearPendenteLocal(id) {
  const db = execFileSync('find', [CFG, '-name', 'agent.db']).toString().trim().split('\n')[0]
  const b64 = cupom(id, true)
  const py = `import sqlite3,sys,time\nc=sqlite3.connect(sys.argv[1])\nc.execute("insert into claimed_items(id,order_number,bytes_b64,paper_width,copies,claimed_at,lease_expires_at,attempts,store_id,print_mode) values(?,?,?,?,?,?,?,?,?,?)",(sys.argv[2],sys.argv[2],open(sys.argv[3]).read(),58,1,int(time.time()*1000),int(time.time()*1000)+120000,0,sys.argv[4],'escpos'))\nc.commit()\nprint(c.execute('select count(*) from claimed_items').fetchone()[0])`
  const tmp = path.join(CFG, 'b64.txt')
  fs.writeFileSync(tmp, b64)
  const n = execFileSync('python3', ['-I', '-c', py, db, id, tmp, STORE_ID]).toString().trim()
  log(`💾 BANCO LOCAL: pedido ${id} semeado como pendente do boot anterior (linhas: ${n})`)
}

// ---------------- roteiro ----------------
const r = {}
async function main() {
  console.log(`\n===== ${ROTULO} (${APP_DIR}) =====`)

  // Preparação
  abrirApp('preparação')
  await sleep(4000)
  log(`   connect → ${JSON.stringify(await telaEval("window.printAgent.connect('vnzpa_teste')")).slice(0, 80)}`)
  log(`   setPrinter → ${JSON.stringify(await telaEval("window.printAgent.setPrinter({ type: 'network', host: '127.0.0.1', port: 9101, paperWidth: 58, printMode: 'escpos' })"))}`)
  await esperar(() => wsClients.size > 0, 15_000)
  await sleep(2000)
  await fecharApp()

  // ===== Caso 3: handshake do WebSocket que nunca responde =====
  console.log('\n----- Caso 3: WebSocket com handshake que nunca responde -----')
  wsTravado = true
  const u0 = upgrades
  abrirApp('WebSocket travado no handshake')
  await sleep(70_000)
  const tentativas = upgrades - u0
  r.c3 = `${tentativas} tentativa(s) de WebSocket em 70 s com o handshake travado`
  log(`➡️  CASO 3: ${r.c3}`)
  wsTravado = false
  await fecharApp()

  // ===== Caso 1: suspensão no meio da reimpressão das pendentes =====
  console.log('\n----- Caso 1: suspensão + retomada no meio da reimpressão das pendentes -----')
  semearPendenteLocal('local-1')
  segurar = { id: 'local-1', ms: 20_000 }
  abrirApp('boot com 1 pendente no banco local')
  await esperar(() => impressaoAtual?.id === 'local-1', 30_000)
  await sleep(3000)
  await powerMonitor('suspend')
  log("💤 APP: 'suspend' no meio da reimpressão de local-1")
  await sleep(2000)
  await powerMonitor('resume')
  log("☀️  APP: 'resume' (o pós-resume roda 5 s depois, com a reimpressão ainda em andamento)")
  await esperar(() => impressoes['local-1'] >= 1, 40_000)
  await sleep(3000)
  const j1 = addJob('depois da reimpressão, sem campainha')
  const ok1 = await esperar(() => impressoes[j1] >= 1, 120_000)
  r.c1 = ok1 ? `a busca voltou: ${j1} saiu` : `a busca MORREU: ${j1} ficou 120 s na fila`
  log(`➡️  CASO 1: ${r.c1}`)
  console.log('   últimos logs:')
  for (const l of await ultimosLogs(14)) console.log(l)
  await fecharApp()

  // ===== Caso 2: suspensão no meio de um pedido =====
  console.log('\n----- Caso 2: suspensão + retomada no meio de um pedido -----')
  abrirApp('app saudável')
  await esperar(() => wsClients.size > 0, 20_000)
  await sleep(5000)
  const j2 = addJob('cupom grande, a impressora segura 20 s', true)
  segurar = { id: j2, ms: 20_000 }
  tocarCampainha()
  await esperar(() => impressaoAtual?.id === j2, 20_000)
  await sleep(3000)
  await powerMonitor('suspend')
  log(`💤 APP: 'suspend' no meio da impressão de ${j2}`)
  await sleep(2000)
  await powerMonitor('resume')
  log("☀️  APP: 'resume'")
  await esperar(() => impressoes[j2] >= 1, 40_000)
  await sleep(30_000)
  r.c2 = impressoes[j2] === 1 ? `${j2} saiu 1 vez` : `${j2} saiu ${impressoes[j2] ?? 0} vezes (DOBRADO)`
  log(`➡️  CASO 2: ${r.c2}`)
  console.log('   últimos logs:')
  for (const l of await ultimosLogs(14)) console.log(l)
  await fecharApp()

  console.log(`\n===== RESUMO ${ROTULO} =====`)
  console.log(`  1. Suspensão na reimpressão das pendentes: ${r.c1}`)
  console.log(`  2. Suspensão no meio de um pedido:        ${r.c2}`)
  console.log(`  3. Handshake do WebSocket travado:         ${r.c3}`)
  process.exit(0)
}
main().catch((e) => {
  console.error('FALHOU:', e)
  try {
    if (appProc) process.kill(-appProc.pid, 'SIGKILL')
  } catch {}
  process.exit(1)
})
