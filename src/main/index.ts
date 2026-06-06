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
import { ApiClient, rawPostJson } from '@lib/api/client'
import { PrintAgentEndpoints } from '@lib/api/endpoints'
import { TokenManager, type ExchangeResult } from '@lib/auth/tokenManager'
import { getFingerprint } from '@lib/auth/device'
import { startMockBackend, type MockHandle } from '@lib/api/mock-backend'
import { readJsonFile } from '@lib/storage/jsonStore'
import { openDbWithRecovery, closeDb } from '@lib/storage/db'
import { LocalQueue } from '@lib/queue/localQueue'
import { LogsStore } from '@lib/logs/logsStore'
import { TelemetryBuffer } from '@lib/telemetry/buffer'
import { TelemetryService } from '@lib/telemetry/service'
import { Heartbeat } from '@lib/telemetry/heartbeat'
import { sanitize } from '@lib/telemetry/sanitize'
import { QueueLoop } from '@lib/queue/queueLoop'
import { WsClient } from '@lib/queue/wsClient'
import { detectPrintMode } from '@lib/printer'
import type { AgentStatus, AgentSnapshot, Preferences, PrinterConfig } from '@shared/types'
import { formatLogTime } from '@shared/logTime'
import { AgentState, makeInitialSnapshot } from './agentState'
import { registerIpc } from './ipc'
import { createTray, type TrayController } from './tray'
import { applyAutoStart, startedHidden } from './autoStart'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let mock: MockHandle | null = null
let queueLoop: QueueLoop | null = null
let heartbeat: Heartbeat | null = null
let wsClient: WsClient | null = null
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
    const localQueue = new LocalQueue(db)
    const telemetryBuffer = new TelemetryBuffer(db)
    const logsStore = new LogsStore(db)

    const pruned = telemetryBuffer.pruneOlderThan()
    const logsPruned = logsStore.pruneOlderThan()
    // Prune coordenado a cada 6h pra ambos os buffers.
    pruneTimer = setInterval(() => {
      telemetryBuffer.pruneOlderThan()
      logsStore.pruneOlderThan()
    }, PRUNE_INTERVAL_MS)

    const device = await getFingerprint()
    const tokenManager = new TokenManager(async (refreshToken): Promise<ExchangeResult> => {
      return rawPostJson<ExchangeResult>(
        `${config.apiBaseUrl}/api/print-agent/token/exchange`,
        {
          refreshToken,
          agentInstallId: device.agentInstallId,
          hostname: device.hostname,
          // v0.4.0: enviar agentVersion no exchange também (não só no ping/telemetria).
          // Server preenche print_agent_tokens.agent_version aqui — admin consegue
          // ver qual versão cada PC está rodando direto na tela de tokens.
          agentVersion: app.getVersion(),
          os: process.platform
        }
      )
    })
    const apiClient = new ApiClient(tokenManager)
    const endpoints = new PrintAgentEndpoints(apiClient)
    const telemetry = new TelemetryService(apiClient, telemetryBuffer, device, app.getVersion())

    heartbeat = new Heartbeat({
      endpoints,
      device,
      telemetry,
      appVersion: app.getVersion(),
      intervalMs: config.heartbeatIntervalMs
    })

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
      telemetry.emit({
        type: 'printer_state_change',
        errorMessage: `${prevStatus} -> ${snap.status}: ${snap.statusMessage}`,
        ...ctx
      })
      prevStatus = snap.status
    })

    const initial = state.get()
    const [persistedPrinter, persistedPrefs] = await Promise.all([
      readJsonFile<PrinterConfig>('printer', initial.printer),
      readJsonFile<Preferences>('preferences', initial.preferences)
    ])
    state.patch({ printer: persistedPrinter, preferences: persistedPrefs })
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

    queueLoop = new QueueLoop({
      endpoints,
      state,
      localQueue,
      telemetry,
      getPrinterConfig: () => state.get().printer,
      intervalMs: config.pollIntervalMs
    })

    // v1.0.0: WebSocket "campainha". O push de pedido chama kick() (tick
    // imediato); ao conectar, o poll vira backstop longo; ao cair, volta pro
    // poll normal até reconectar. claim/print/ack seguem no QueueLoop via HTTP.
    wsClient = new WsClient({
      url: config.wsUrl,
      tokens: tokenManager,
      state,
      onJob: () => queueLoop?.kick(),
      onConnected: () => {
        queueLoop?.setIntervalMs(config.wsBackstopPollMs)
        queueLoop?.kick() // catch-up: drena o que entrou enquanto desconectado
      },
      onDisconnected: () => queueLoop?.setIntervalMs(config.pollIntervalMs)
    })

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
        // Restart do loop reseta consecutiveListErrors e o backoff acumulado.
        // Resetar intervalMs pro polling curto explicitamente — sem WS conectado
        // pra dar push, polling tem que ser frequente. (Quando o WS reconectar,
        // onConnected volta o intervalo pro backstop longo.) Sem isso, o
        // queueLoop herdava o backstop de 180s da conexão WS anterior, e o
        // próximo tick só rodava 3 min depois — apesar do recovery ter sido OK.
        queueLoop?.stop()
        queueLoop?.setIntervalMs(config.pollIntervalMs)
        void queueLoop?.start()
        // stop()+start() em vez de forceReconnect(): o suspend marcou active=false
        // no wsClient, então forceReconnect() (que tem `if (!active) return`)
        // viraria no-op. start() promove active=true e dispara connect.
        wsClient?.stop()
        wsClient?.start()
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
      queueLoop?.stop()
      wsClient?.stop()
    })
    powerMonitor.on('resume', () => scheduleRecovery('resume'))
    powerMonitor.on('unlock-screen', () => scheduleRecovery('unlock-screen'))

    // Reage a eventos do token: refresh ok, refresh recusado (token revogado),
    // ou falha de rede no refresh. Tudo loga + faz a recuperação de estado.
    tokenManager.on('refresh-success', (info: { expiresInSec: number }) => {
      const minutes = Math.round(info.expiresInSec / 60)
      state.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `Sessão renovada (válida por ${minutes} min).`
      })
    })
    tokenManager.on('refresh-rejected', () => {
      // Refresh token foi revogado/expirado no servidor — o agent não tem
      // como se recuperar sozinho. Para tudo e força reauth manual.
      state.pushLog({
        time: formatLogTime(),
        level: 'error',
        message:
          'Token de conexão foi revogado pelo servidor. Gere um novo token no painel da loja e cole no campo de conexão.'
      })
      queueLoop?.stop()
      heartbeat?.stop()
      wsClient?.stop()
      void tokenManager.clear()
      state.setConnection(false, null, null)
      state.setStatus(
        'red',
        'Sessão expirada — gere um novo token no painel e cole aqui.'
      )
    })
    tokenManager.on('refresh-failed', (err: Error) => {
      // Erro de rede/server, não auth — vai retentar no próximo tick do polling.
      state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `Falha ao renovar sessão: ${err.message}`
      })
    })

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
        tokens: tokenManager,
        endpoints,
        device,
        appVersion: app.getVersion(),
        queueLoop,
        heartbeat,
        telemetry
      },
      () => mainWindow
    )

    // Telemetria de boot. Vai pro buffer se offline; drena no primeiro heartbeat.
    telemetry.emit({ type: 'agent_started' })

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
    const pendingLocal = localQueue.count()
    if (pendingLocal > 0) {
      state.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `${pendingLocal} pedido(s) pendente(s) no banco local — recover ao conectar.`
      })
    }
    const pendingTelemetry = telemetryBuffer.count()
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
        telemetry.enqueueSync({
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
        telemetry.enqueueSync({
          type: 'agent_crashed',
          errorCode: 'UNHANDLED_REJECTION',
          errorMessage: sanitize(msg).slice(0, 200)
        })
      } catch {
        /* swallow */
      }
      console.error('[main] unhandledRejection:', reason)
    })

    if (await tokenManager.hasRefreshToken()) {
      try {
        await endpoints.ping({
          agentInstallId: device.agentInstallId,
          hostname: device.hostname,
          machineIdHash: device.machineIdHash,
          agentVersion: app.getVersion()
        })
        const store = tokenManager.getStore()
        state.setConnection(true, store?.name ?? 'Loja conectada', store?.id ?? null)
        state.setStatus('green', 'Conectado e pronto pra imprimir.')
        heartbeat.start()
        await queueLoop.start()
        wsClient.start()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        state.pushLog({
          time: formatLogTime(),
          level: 'warn',
          message: `Reconexão silenciosa falhou: ${msg}`
        })
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', async (event) => {
    isQuitting = true
    const loop = queueLoop
    queueLoop?.stop()
    heartbeat?.stop()
    wsClient?.stop()
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
    const needsRelease = loop?.getInFlightClaimId() != null
    if (needsRelease || mock) {
      event.preventDefault()
      const h = mock
      mock = null
      const shutdownTasks: Promise<void>[] = []
      if (loop) shutdownTasks.push(loop.releaseInFlightBestEffort(2_000))
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
