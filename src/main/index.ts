// Build legado: TEM que ser o primeiro import — ver polyfills.ts.
import './polyfills'
import { app, BrowserWindow, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import dns from 'node:dns'
import { config } from '@lib/config'

// v0.4.0: força resolução DNS IPv4 antes de IPv6. Sem isso, no Windows o
// Node tenta AAAA primeiro; se o roteador/ISP tiver glitch momentâneo no
// IPv6, a tentativa falha com ENOTFOUND e o fallback pra A não acontece
// rápido — vimos casos de 5min de polling falhando ao seguir. Nosso server
// (api.vendanozap.app -> vendanozap-api.fly.dev) só tem A record mesmo,
// IPv6 nunca seria útil aqui.
dns.setDefaultResultOrder('ipv4first')
import { getFingerprint } from '@lib/auth/device'
import {
  loadAccounts,
  upsertAccount,
  removeAccount,
  type StoredAccount
} from '@lib/auth/accountsStore'
import { startMockBackend, type MockHandle } from '@lib/api/mock-backend'
import { readJsonFile } from '@lib/storage/jsonStore'
import { openDbWithRecovery, closeDb } from '@lib/storage/db'
import { LogsStore } from '@lib/logs/logsStore'
import { TelemetryBuffer } from '@lib/telemetry/buffer'
import { sanitize } from '@lib/telemetry/sanitize'
import { detectPrintMode } from '@lib/printer'
import type { AgentStatus, AgentSnapshot, Preferences, PrinterConfig } from '@shared/types'
import { formatLogTime } from '@shared/logTime'
import { AgentState, makeInitialSnapshot } from './agentState'
import { StoreConnection } from './storeConnection'
import { Mutex } from 'async-mutex'
import { registerIpc } from './ipc'
import { createTray, type TrayController } from './tray'
import { applyAutoStart, startedHidden } from './autoStart'

const isDev = !app.isPackaged

// Build legado: PCs com Windows 7/8.1 costumam ter driver de vídeo antigo, e o
// sintoma clássico do Chromium nesses casos é a janela abrir em branco/preta.
// A interface é um formulário simples — renderizar por software não custa nada
// e tira essa variável da mesa. Tem que ser chamado ANTES do app ficar pronto.
app.disableHardwareAcceleration()

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let mock: MockHandle | null = null
/** v1.11.0: uma conexão por loja. A impressora é uma só — `printerMutex`
 *  serializa o papel entre elas. */
const connections = new Map<string, StoreConnection>()
const printerMutex = new Mutex()
let pruneTimer: NodeJS.Timeout | null = null
let resumeTimer: NodeJS.Timeout | null = null
let isQuitting = false

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
// v1.7.0: tempo de espera antes de tentar reconectar após resume. Janela
// observada no campo (Windows 11 + Wi-Fi AX2xx): NIC leva 2-5s pra revalidar
// DHCP/DNS depois que sai de S0ix. 5s cobre com folga.
const POST_RESUME_DELAY_MS = 5_000

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
    show: false,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Venda no Zap Print Agent',
    backgroundColor: '#FCF9F5',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F47527',
      symbolColor: '#FFFFFF',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // DevTools só em dev. Em produção evita que o lojista abra por acidente
      // (Ctrl+Shift+I) e veja erros internos / acesse APIs do Electron.
      devTools: isDev
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Quando o Windows lança via auto-start (com --hidden), só sobe na bandeja.
    if (!startedHidden()) mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    if (config.useMock) {
      try {
        mock = await startMockBackend(config.mockPort)
        for (let i = 0; i < 3; i++) {
          mock.seedJob({ orderNumber: String(1001 + i) })
        }
      } catch (e) {
        console.error('[main] mock backend failed to start:', e)
      }
    }

    const { db, recovered: dbRecovered } = openDbWithRecovery()
    // Buffer sem escopo: serve só pro prune (DELETE por idade, vale pra todas
    // as lojas). Cada StoreConnection cria o seu, recortado por store_id.
    const telemetryBuffer = new TelemetryBuffer(db)
    const logsStore = new LogsStore(db)
    // Crash pode acontecer antes de qualquer loja conectar, e aí não existe
    // TelemetryService pra enfileirar. Gravamos direto com store_id NULL: no
    // próximo boot a primeira loja adota (adoptsLegacyRows) e envia.
    const enqueueCrash = (payload: Record<string, unknown>): void => {
      try {
        db.prepare(
          'INSERT INTO telemetry_buffer (payload, created_at, attempts, store_id) VALUES (?, ?, 0, NULL)'
        ).run(JSON.stringify(payload), Date.now())
      } catch {
        /* swallow */
      }
    }
    const countAll = (table: string): number => {
      try {
        return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
      } catch {
        return 0
      }
    }

    const pruned = telemetryBuffer.pruneOlderThan()
    const logsPruned = logsStore.pruneOlderThan()
    // Prune coordenado a cada 6h pra ambos os buffers.
    pruneTimer = setInterval(() => {
      telemetryBuffer.pruneOlderThan()
      logsStore.pruneOlderThan()
    }, PRUNE_INTERVAL_MS)

    const device = await getFingerprint()
    const state = new AgentState(makeInitialSnapshot(app.getVersion()))
    state.on('change', (snap) => tray?.setStatus(snap.status))

    // Persiste cada pushLog no SQLite (retenção 48h). Configurar ANTES dos
    // primeiros pushLog do boot pra não perder o histórico de inicialização.
    state.setLogSink((entry) => {
      try {
        logsStore.append(entry)
      } catch {
        /* swallow — log não deve quebrar o agente */
      }
    })

    // Restaura na UI o histórico persistido (últimos 100, mais recentes primeiro).
    const recentLogs = logsStore.recent(100)
    if (recentLogs.length > 0) {
      state.patch({ logs: recentLogs })
    }

    // Emite printer_state_change quando o status muda.
    let prevStatus: AgentStatus = state.get().status
    state.on('change', (snap: AgentSnapshot) => {
      if (snap.status === prevStatus) return
      const ctx = snap.printer.type === 'network' && snap.printer.host
        ? { printerType: snap.printer.type, printerHost: snap.printer.host }
        : { printerType: snap.printer.type }
      // A impressora é da máquina, então a mudança interessa a TODAS as lojas
      // conectadas — cada uma tem seu próprio destino de telemetria.
      for (const conn of connections.values()) {
        conn.telemetry.emit({
          type: 'printer_state_change',
          errorMessage: `${prevStatus} -> ${snap.status}: ${snap.statusMessage}`,
          ...ctx
        })
      }
      prevStatus = snap.status
    })

    const initial = state.get()
    const [persistedPrinter, persistedPrefs] = await Promise.all([
      readJsonFile<PrinterConfig>('printer', initial.printer),
      readJsonFile<Preferences>('preferences', initial.preferences)
    ])
    // Arquivo gravado por versão anterior não tem as chaves novas — o spread
    // sobre o default garante boolean em vez de undefined (Switch controlado).
    state.patch({
      printer: persistedPrinter,
      preferences: { ...initial.preferences, ...persistedPrefs }
    })
    // Sincroniza a preferência de auto-start com o registro do Windows
    // (em dev é no-op).
    applyAutoStart(persistedPrefs.autoStart)

    // Detecta o modo de impressão da impressora persistida pra UI já abrir
    // com badge "Modo Compatibilidade" se for o caso, em vez de só refletir
    // depois do primeiro claim ou clique em testar. Async — não bloqueia o
    // boot; em até 10s o PowerShell responde e o state atualiza.
    void detectPrintMode(persistedPrinter).then((d) => {
      state.setPrintMode(d.mode, d.driver)
      if (d.reason === 'detected') {
        const driverStr = d.driver ?? '(sem nome)'
        const modeStr = d.mode === 'compatibility' ? 'compatibilidade' : 'normal (ESC/POS)'
        state.pushLog({
          time: formatLogTime(),
          level: d.mode === 'compatibility' ? 'warn' : 'info',
          message: `Driver detectado [boot]: "${driverStr}" → modo ${modeStr}.`
        })
      } else if (d.reason !== 'no-spooler-name' && d.reason !== 'not-spooler') {
        state.pushLog({
          time: formatLogTime(),
          level: 'warn',
          message: `Detecção de driver [boot] indeterminada: ${d.reason}${d.error ? ` — ${d.error}` : ''}. Default: ESC/POS.`
        })
      }
    })

    // v1.11.0: cria (sem iniciar) a pilha de uma loja. `adoptsLegacyRows` só
    // pra primeira: as linhas sqlite gravadas antes da atualização não têm
    // store_id e pertencem à única loja que existia.
    const makeConnection = (storeId: string, storeName: string): StoreConnection =>
      new StoreConnection(storeId, storeName, {
        db,
        state,
        device,
        appVersion: app.getVersion(),
        getPrinterConfig: () => state.get().printer,
        withPrinter: (fn) => printerMutex.runExclusive(fn),
        adoptsLegacyRows: connections.size === 0
      })

    /** Conecta (ou reconecta) uma loja a partir do refresh token e persiste. */
    const connectStore = async (
      refreshToken: string
    ): Promise<{ storeId: string; storeName: string }> => {
      const conn = makeConnection('', '')
      const { storeId, storeName } = await conn.authenticate(refreshToken)
      // Já havia conexão dessa loja (recolar o mesmo token): derruba a antiga
      // pra não existirem dois loops claimando o mesmo pedido.
      const previous = connections.get(storeId)
      if (previous) previous.stop()
      connections.set(storeId, conn)
      state.upsertStore({
        storeId,
        storeName,
        status: 'green',
        statusMessage: 'Conectado e pronto pra imprimir.'
      })
      await upsertAccount({ storeId, storeName, refreshToken })
      await conn.start()
      return { storeId, storeName }
    }

    const disconnectStore = async (storeId: string): Promise<void> => {
      const conn = connections.get(storeId)
      if (conn) {
        conn.stop()
        await conn.clearToken()
        connections.delete(storeId)
      }
      state.removeStore(storeId)
      await removeAccount(storeId)
    }

    // v1.7.0: Modern Standby do Windows 11 + Wi-Fi Intel AX2xx desliga a NIC
    // em S0ix mantendo a sessão "ativa". Sem tratamento, o socket WS fica
    // fantasma (TCP "OPEN" mas nada trafega), o polling falha com ENOTFOUND
    // por minutos, e o lojista vê pedidos chegando com atraso. Tratamos 3
    // eventos do powerMonitor:
    //   - 'suspend': S3/S4 — pausa tudo
    //   - 'resume':  S3/S4 — espera 5s pra NIC voltar, força reconnect WS,
    //                reinicia o queue loop com intervalo curto (não no
    //                backstop longo) pra confirmar saúde rápido
    //   - 'unlock-screen': cobre Modern Standby + Win+L manual; mesmo
    //                tratamento do resume, mas mais conservador. Se for só
    //                Win+L (sem sleep), o restart é no-op em prática.
    function scheduleRecovery(reason: string): void {
      if (!state.get().connection.connected) return
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `Sistema retomado (${reason}) — reconectando em ${POST_RESUME_DELAY_MS / 1000}s.`
      })
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => {
        resumeTimer = null
        if (!state.get().connection.connected) return
        for (const conn of connections.values()) void conn.resumeAfterWake()
        // resumeAfterWake faz stop()+start() do loop e do WS: reseta
        // consecutiveListErrors, backoff e o estado paused; e o start() do WS
        // é necessário porque o suspend marcou active=false (forceReconnect
        // viraria no-op).
      }, POST_RESUME_DELAY_MS)
    }

    powerMonitor.on('suspend', () => {
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: 'Sistema entrando em suspensão — pausando agente.'
      })
      if (resumeTimer) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }
      for (const conn of connections.values()) conn.suspend()
    })
    powerMonitor.on('resume', () => scheduleRecovery('resume'))
    powerMonitor.on('unlock-screen', () => scheduleRecovery('unlock-screen'))

    createWindow()
    if (mainWindow) {
      tray = createTray(
        mainWindow,
        () => {
          isQuitting = true
          app.quit()
        },
        mock ? { devSeedJob: () => mock!.seedJob() } : {}
      )
    }

    registerIpc(
      {
        state,
        device,
        appVersion: app.getVersion(),
        connections,
        connectStore,
        disconnectStore,
        withPrinter: (fn) => printerMutex.runExclusive(fn)
      },
      () => mainWindow
    )

    state.pushLog({
      time: formatLogTime(),
      level: 'info',
      message: config.useMock
        ? `Mock backend rodando em ${config.apiBaseUrl} (${mock?.state().queue.length ?? 0} pedidos semeados)`
        : `Conectado a ${config.apiBaseUrl}`
    })
    if (dbRecovered) {
      state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message:
          'Banco local estava corrompido — recuperação automática feita. Arquivos antigos preservados como .corrupt.<timestamp> em userData (histórico de logs e telemetria pendente foram perdidos).'
      })
    }
    if (pruned > 0) {
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `${pruned} evento(s) de telemetria expirados removidos.`
      })
    }
    if (logsPruned > 0) {
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `${logsPruned} log(s) com mais de 48h removidos.`
      })
    }
    const pendingLocal = countAll('claimed_items')
    if (pendingLocal > 0) {
      state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `${pendingLocal} pedido(s) pendente(s) no banco local — recover ao conectar.`
      })
    }
    const pendingTelemetry = countAll('telemetry_buffer')
    if (pendingTelemetry > 0) {
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `${pendingTelemetry} evento(s) de telemetria buffered — envio em background.`
      })
    }

    // Handlers de crash — escreve direto no buffer (sync sqlite). drainBuffer
    // no próximo boot envia.
    process.on('uncaughtException', (err) => {
      try {
        enqueueCrash({
          type: 'agent_crashed',
          errorCode: 'UNCAUGHT_EXCEPTION',
          errorMessage: sanitize(err?.message ?? String(err)).slice(0, 200)
        })
      } catch {
        /* swallow */
      }
      console.error('[main] uncaughtException:', err)
    })
    process.on('unhandledRejection', (reason) => {
      try {
        const msg = reason instanceof Error ? reason.message : String(reason)
        enqueueCrash({
          type: 'agent_crashed',
          errorCode: 'UNHANDLED_REJECTION',
          errorMessage: sanitize(msg).slice(0, 200)
        })
      } catch {
        /* swallow */
      }
      console.error('[main] unhandledRejection:', reason)
    })

    // Reconexão silenciosa de TODAS as lojas salvas. Falha de uma não impede
    // as outras: cada uma vira uma linha vermelha na lista, e a bandeja mostra
    // o pior estado. `agent_started` sai por loja, depois que ela autentica.
    const saved: StoredAccount[] = await loadAccounts()
    for (const acc of saved) {
      try {
        const { storeName } = await connectStore(acc.refreshToken)
        connections.get(acc.storeId || '')?.telemetry.emit({ type: 'agent_started' })
        state.pushLog({
          time: formatLogTime(),
          level: 'info',
          message: `Conectado à loja: ${storeName}`
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const nome = acc.storeName || 'loja salva'
        if (acc.storeId) {
          state.upsertStore({
            storeId: acc.storeId,
            storeName: nome,
            status: 'red',
            statusMessage: 'Sem conexão — tentando de novo no próximo ciclo.'
          })
        }
        state.pushLog({
          time: formatLogTime(),
          level: 'warn',
          message: `Reconexão silenciosa falhou (${nome}): ${msg}`
        })
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', async (event) => {
    isQuitting = true
    const live = [...connections.values()]
    for (const conn of live) conn.stop()
    if (pruneTimer) {
      clearInterval(pruneTimer)
      pruneTimer = null
    }
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    // Se tinha um claim em vôo, tenta soltar best-effort (2s max) pro item
    // voltar pra fila do servidor antes do lease expirar.
    const needsRelease = live.some((c) => c.getInFlightClaimId() != null)
    if (needsRelease || mock) {
      event.preventDefault()
      const h = mock
      mock = null
      // 2s no total pra TODAS as lojas — o shutdown não pode esticar por ter
      // duas conexões. Cada release é best-effort e falha calado.
      const shutdownTasks: Promise<void>[] = [
        Promise.race([
          Promise.allSettled(live.map((c) => c.releaseInFlight().catch(() => {}))).then(() => {}),
          new Promise<void>((r) => setTimeout(r, 2_000))
        ])
      ]
      if (h) shutdownTasks.push(h.stop().catch(() => {}))
      await Promise.allSettled(shutdownTasks)
      closeDb()
      app.quit()
    } else {
      closeDb()
    }
  })

  app.on('window-all-closed', () => {
    /* mantém vivo na bandeja */
  })
}
