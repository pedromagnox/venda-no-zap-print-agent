import { ipcMain, clipboard, type BrowserWindow } from 'electron'
import type { AgentState } from './agentState'
import type { TokenManager } from '@lib/auth/tokenManager'
import type { PrintAgentEndpoints } from '@lib/api/endpoints'
import type { DeviceFingerprint } from '@lib/auth/device'
import {
  makePrinter,
  buildTestPage,
  PrinterError,
  listSpoolerPrinters
} from '@lib/printer'
import type { DiscoveredSpoolerPrinter } from '@lib/printer'
import { writeJsonFile } from '@lib/storage/jsonStore'
import { applyAutoStart } from './autoStart'
import type { QueueLoop } from '@lib/queue/queueLoop'
import type { Heartbeat } from '@lib/telemetry/heartbeat'
import type { TelemetryService } from '@lib/telemetry/service'
import { randomUUID } from 'node:crypto'
import type { AgentSnapshot, PrinterConfig, Preferences, PrinterType } from '@shared/types'

export type IpcDeps = {
  state: AgentState
  tokens: TokenManager
  endpoints: PrintAgentEndpoints
  device: DeviceFingerprint
  appVersion: string
  queueLoop: QueueLoop
  heartbeat: Heartbeat
  telemetry: TelemetryService
}

export type ConnectResult =
  | { ok: true; storeName: string }
  | { ok: false; error: string }

export type TestPrintResult =
  | { ok: true }
  | { ok: false; error: string; code?: string; hint?: string }

/** Mensagem orientativa pra ajudar o lojista a resolver sozinho. */
function buildErrorHint(printerType: PrinterType, code: string): string {
  if (printerType === 'windows_spooler') {
    if (code === 'DRIVER_MISSING' || code === 'IO_ERROR' || code === 'TIMEOUT' || code === 'OFFLINE') {
      return (
        'Abra Painel de Controle > Dispositivos e Impressoras > clique direito na ' +
        'impressora > Propriedades > aba Portas, e confirme que a porta está em USB001 ' +
        '(ou similar) — não em LPT1.'
      )
    }
    if (code === 'ACCESS_DENIED') {
      return 'O Windows recusou acesso ao spooler. Reinicie o serviço de Spooler ou rode o app como Administrador.'
    }
  }
  if (printerType === 'network') {
    if (code === 'CONN_REFUSED' || code === 'TIMEOUT' || code === 'OFFLINE') {
      return 'Confirme o IP da impressora e se ela está na mesma rede. Tente: ping <ip-da-impressora>.'
    }
  }
  return ''
}

function nowLogTime(): string {
  return new Date().toLocaleTimeString('pt-BR')
}

function printerContext(config: PrinterConfig): {
  printerType: PrinterType
  printerHost?: string
} {
  if (config.type === 'network' && config.host) {
    return { printerType: 'network', printerHost: config.host }
  }
  return { printerType: config.type }
}

export function registerIpc(deps: IpcDeps, getWindow: () => BrowserWindow | null): void {
  const { state, tokens, endpoints, device, appVersion, queueLoop, heartbeat, telemetry } = deps

  ipcMain.handle('agent:getSnapshot', (): AgentSnapshot => state.get())

  state.on('change', (snap: AgentSnapshot) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:snapshot', snap)
    }
  })

  ipcMain.handle('app:version', () => appVersion)

  ipcMain.handle('app:readClipboard', (): string => {
    try {
      return clipboard.readText() ?? ''
    } catch {
      return ''
    }
  })

  ipcMain.handle('agent:connect', async (_e, refreshToken: string): Promise<ConnectResult> => {
    if (typeof refreshToken !== 'string' || refreshToken.trim().length < 4) {
      return { ok: false, error: 'Token inválido — cole o token gerado no painel da loja.' }
    }
    await tokens.setRefreshToken(refreshToken.trim())
    try {
      await endpoints.ping({
        agentInstallId: device.agentInstallId,
        hostname: device.hostname,
        machineIdHash: device.machineIdHash,
        agentVersion: appVersion
      })
      const store = tokens.getStore()
      const storeName = store?.name ?? 'Loja conectada'
      state.setConnection(true, storeName)
      state.setStatus('green', 'Conectado e pronto pra imprimir.')
      state.pushLog({ time: nowLogTime(), level: 'info', message: `Conectado à loja: ${storeName}` })
      heartbeat.start()
      await queueLoop.start()
      return { ok: true, storeName }
    } catch (err) {
      await tokens.clear()
      state.setConnection(false, null)
      state.setStatus('red', 'Falha na conexão — verifique o token.')
      const msg = err instanceof Error ? err.message : String(err)
      state.pushLog({ time: nowLogTime(), level: 'error', message: `Falha ao conectar: ${msg}` })
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('agent:disconnect', async () => {
    queueLoop.stop()
    heartbeat.stop()
    await tokens.clear()
    state.setConnection(false, null)
    state.setStatus('yellow', 'Desconectado. Cole um novo token pra reconectar.')
  })

  ipcMain.handle(
    'agent:setPrinter',
    async (_e, printer: PrinterConfig): Promise<{ ok: boolean; error?: string }> => {
      state.setPrinter(printer)
      try {
        await writeJsonFile('printer', printer)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        state.pushLog({
          time: nowLogTime(),
          level: 'error',
          message: `Falha ao salvar configuração da impressora: ${msg}`
        })
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle(
    'agent:setPreferences',
    async (_e, prefs: Preferences): Promise<{ ok: boolean; error?: string }> => {
      state.setPreferences(prefs)
      try {
        await writeJsonFile('preferences', prefs)
        applyAutoStart(prefs.autoStart)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        state.pushLog({
          time: nowLogTime(),
          level: 'error',
          message: `Falha ao salvar preferências: ${msg}`
        })
        return { ok: false, error: msg }
      }
    }
  )

  ipcMain.handle('agent:testPrint', async (): Promise<TestPrintResult> => {
    const config = state.get().printer
    const startedAt = Date.now()
    telemetry.emit({ type: 'print_attempt', ...printerContext(config) })
    try {
      const printer = makePrinter(config)
      try {
        await printer.print(buildTestPage())
      } finally {
        await printer.close()
      }
      const durationMs = Date.now() - startedAt
      state.pushHistory({
        id: `test_${randomUUID().slice(0, 8)}`,
        orderNumber: 'TESTE',
        printedAt: new Date().toISOString(),
        status: 'success'
      })
      state.pushLog({
        time: nowLogTime(),
        level: 'info',
        message: `Teste impresso em ${printer.describe()} (${durationMs}ms)`
      })
      state.setStatus('green', 'Teste impresso com sucesso.')
      telemetry.emit({ type: 'print_success', durationMs, ...printerContext(config) })
      return { ok: true }
    } catch (err) {
      const code = err instanceof PrinterError ? err.code : 'IO_ERROR'
      const msg = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - startedAt
      state.pushHistory({
        id: `test_${randomUUID().slice(0, 8)}`,
        orderNumber: 'TESTE',
        printedAt: new Date().toISOString(),
        status: 'failure'
      })
      const hint = buildErrorHint(config.type, code)
      state.pushLog({
        time: nowLogTime(),
        level: 'error',
        message: `Teste falhou (${code}): ${msg}${hint ? '. ' + hint : ''}`
      })
      state.setStatus('red', `Erro na impressora: ${code}`)
      telemetry.emit({
        type: 'print_failure',
        durationMs,
        errorCode: code,
        errorMessage: msg,
        ...printerContext(config)
      })
      return { ok: false, error: msg, code, hint }
    }
  })

  ipcMain.handle('agent:listSpoolerPrinters', async (): Promise<DiscoveredSpoolerPrinter[]> => {
    try {
      return await listSpoolerPrinters()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.pushLog({
        time: nowLogTime(),
        level: 'warn',
        message: `Listagem spooler falhou: ${msg}`
      })
      return []
    }
  })
}
