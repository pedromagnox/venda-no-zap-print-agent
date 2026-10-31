import type Database from 'better-sqlite3'
import { ApiClient, rawPostJson } from '@lib/api/client'
import { PrintAgentEndpoints } from '@lib/api/endpoints'
import { TokenManager, type ExchangeResult } from '@lib/auth/tokenManager'
import type { DeviceFingerprint } from '@lib/auth/device'
import { LocalQueue } from '@lib/queue/localQueue'
import { QueueLoop } from '@lib/queue/queueLoop'
import { WsClient } from '@lib/queue/wsClient'
import { TelemetryBuffer } from '@lib/telemetry/buffer'
import { TelemetryService } from '@lib/telemetry/service'
import { Heartbeat } from '@lib/telemetry/heartbeat'
import { config } from '@lib/config'
import type { PrinterConfig } from '@shared/types'
import { hasPrinterTarget } from '@lib/printer'
import { formatLogTime } from '@shared/logTime'
import type { AgentState } from './agentState'

// v1.11.0: tudo que é POR LOJA vive aqui — token, endpoints, telemetria,
// heartbeat, fila e WebSocket. O que é da MÁQUINA (impressora, preferências,
// banco local, logs, bandeja) continua único e é injetado de fora.
//
// Uma instalação passa a ter N destes, um por loja conectada. É o que permite
// o lojista com duas lojas e uma impressora só receber pedidos das duas ao
// mesmo tempo, em vez de trocar o token toda hora.

export type StoreConnectionDeps = {
  db: Database.Database
  state: AgentState
  device: DeviceFingerprint
  appVersion: string
  getPrinterConfig: () => PrinterConfig
  /** Serializa o acesso à impressora entre TODAS as lojas (uma impressora só). */
  withPrinter: <T>(fn: () => Promise<T>) => Promise<T>
  /** Primeira loja da lista: adota as linhas sqlite gravadas antes da
   *  atualização, que não têm store_id. */
  adoptsLegacyRows: boolean
}

export class StoreConnection {
  readonly tokens: TokenManager
  readonly endpoints: PrintAgentEndpoints
  readonly telemetry: TelemetryService
  private readonly heartbeat: Heartbeat
  private readonly queueLoop: QueueLoop
  private readonly wsClient: WsClient
  private readonly localQueue: LocalQueue

  storeId: string
  storeName: string

  private readonly scopedState: ReturnType<AgentState['scopedFor']>
  /** v1.11.3: quando o Windows avisou a suspensão (null = não suspensa). */
  private suspendedAt: number | null = null
  /** Suspensa há mais que isso com o ping dando certo = o 'resume' não veio. */
  private static readonly VIGIA_APOS_SUSPENSAO_MS = 60_000
  /** v1.11.4: entre start() e stop(). O vigia só religa a busca de quem está de pé. */
  private rodando = false

  constructor(
    storeId: string,
    storeName: string,
    private readonly deps: StoreConnectionDeps
  ) {
    this.storeId = storeId
    this.storeName = storeName

    this.tokens = new TokenManager(async (refreshToken): Promise<ExchangeResult> => {
      return rawPostJson<ExchangeResult>(`${config.apiBaseUrl}/api/print-agent/token/exchange`, {
        refreshToken,
        agentInstallId: deps.device.agentInstallId,
        hostname: deps.device.hostname,
        agentVersion: deps.appVersion,
        os: process.platform
      })
    })

    const api = new ApiClient(this.tokens)
    this.endpoints = new PrintAgentEndpoints(api)

    // Getters, não o id: a conexão nasce com storeId '' e só descobre a loja no
    // authenticate(). Copiar o id aqui fazia tudo cair na loja ''.
    const lojaAtual = (): string => this.storeId
    const buffer = new TelemetryBuffer(deps.db, lojaAtual, deps.adoptsLegacyRows)
    this.telemetry = new TelemetryService(api, buffer, deps.device, deps.appVersion)
    this.localQueue = new LocalQueue(deps.db, lojaAtual, deps.adoptsLegacyRows)

    const scoped = deps.state.scopedFor(lojaAtual)
    this.scopedState = scoped

    this.heartbeat = new Heartbeat({
      endpoints: this.endpoints,
      device: deps.device,
      telemetry: this.telemetry,
      appVersion: deps.appVersion,
      intervalMs: config.heartbeatIntervalMs,
      getPrinterConfigured: () => hasPrinterTarget(deps.getPrinterConfig()),
      onPingOk: () => this.vigiar()
    })

    this.queueLoop = new QueueLoop({
      endpoints: this.endpoints,
      state: scoped,
      localQueue: this.localQueue,
      telemetry: this.telemetry,
      getPrinterConfig: deps.getPrinterConfig,
      withPrinter: deps.withPrinter,
      intervalMs: config.pollIntervalMs
    })

    this.wsClient = new WsClient({
      url: config.wsUrl,
      tokens: this.tokens,
      state: scoped,
      onJob: () => this.queueLoop.kick(),
      onConnected: () => {
        this.queueLoop.pause()
        this.queueLoop.kickFromReconnect()
      },
      onDisconnected: () => this.queueLoop.resume()
    })

    this.tokens.on('refresh-success', (info: { expiresInSec: number }) => {
      scoped.pushLog({
        time: formatLogTime(),
        level: 'info',
        message: `Sessão renovada (válida por ${Math.round(info.expiresInSec / 60)} min).`
      })
    })
    this.tokens.on('refresh-rejected', () => {
      // Token revogado no painel: esta loja para, as outras seguem.
      scoped.pushLog({
        time: formatLogTime(),
        level: 'error',
        message:
          'Token de conexão foi revogado pelo servidor. Gere um novo token no painel da loja e cole aqui.'
      })
      this.stop()
      deps.state.setStoreStatus(
        this.storeId,
        'red',
        'Sessão expirada — gere um novo token no painel.'
      )
    })
    this.tokens.on('refresh-failed', (err: Error) => {
      scoped.pushLog({
        time: formatLogTime(),
        level: 'warn',
        message: `Falha ao renovar sessão: ${err.message}`
      })
    })
  }

  /** Troca o refresh token por um access token e descobre de qual loja ele é.
   *  Devolve o id/nome pra quem chamou persistir. */
  async authenticate(refreshToken: string): Promise<{ storeId: string; storeName: string }> {
    await this.tokens.setRefreshToken(refreshToken)
    await this.endpoints.ping({
      agentInstallId: this.deps.device.agentInstallId,
      hostname: this.deps.device.hostname,
      machineIdHash: this.deps.device.machineIdHash,
      agentVersion: this.deps.appVersion
    })
    const store = this.tokens.getStore()
    this.storeId = store?.id ?? this.storeId
    this.storeName = store?.name ?? this.storeName ?? 'Loja conectada'
    return { storeId: this.storeId, storeName: this.storeName }
  }

  async start(): Promise<void> {
    this.rodando = true
    this.suspendedAt = null
    this.heartbeat.start()
    await this.queueLoop.start()
    this.wsClient.start()
  }

  stop(): void {
    this.rodando = false
    this.suspendedAt = null
    this.queueLoop.stop()
    this.heartbeat.stop()
    this.wsClient.stop()
  }

  /** Suspensão do Windows: para a fila e o WS sem mexer no token. O heartbeat
   *  segue — é ele que, pelo vigiar(), religa se o 'resume' não vier. */
  suspend(): void {
    this.suspendedAt = Date.now()
    this.queueLoop.stop()
    this.wsClient.stop()
  }

  /** Pós-resume: reinicia loop e WS (ver comentário do scheduleRecovery). */
  async resumeAfterWake(): Promise<void> {
    this.suspendedAt = null
    // v1.11.3: com tick ou recuperação local em andamento, o loop está vivo, e
    // reiniciá-lo agora faria o recoverLocal imprimir de novo o pedido que
    // ainda está saindo (o resume e o vigia podem chegar quase juntos). Aí só
    // o WebSocket recomeça.
    if (!this.queueLoop.isBusy()) {
      this.queueLoop.stop()
      await this.queueLoop.start()
    }
    this.wsClient.stop()
    this.wsClient.start()
  }

  /** v1.11.3: vigia, a cada ping que deu certo (rede e servidor no ar). Religa
   *  a busca de pedidos, como o pós-resume, quando ela está parada:
   *   - suspensa há mais de 1 min sem o 'resume'/'unlock-screen' do Windows.
   *     Na Five Smash (14/10), o pedido ficou 52 min na fila com o ping vivo e
   *     a tela dizendo que estava tudo certo;
   *   - ou ativa e sem tick há mais de 4 min (timer perdido);
   *   - v1.11.4: ou inativa e ociosa, sem suspensão pendente. É o pós-resume
   *     que não reiniciou o loop porque a reimpressão das pendentes ainda
   *     estava em andamento: ela termina, e o loop (parado pela suspensão)
   *     ficava morto. */
  private vigiar(): void {
    const agora = Date.now()
    const suspensaSemRetomada =
      this.suspendedAt !== null && agora - this.suspendedAt > StoreConnection.VIGIA_APOS_SUSPENSAO_MS
    const naoVoltouDaSuspensao =
      this.rodando &&
      this.suspendedAt === null &&
      !this.queueLoop.isActive() &&
      !this.queueLoop.isBusy()
    if (!suspensaSemRetomada && !naoVoltouDaSuspensao && !this.queueLoop.estaParada(agora)) return
    this.scopedState.pushLog({
      time: formatLogTime(),
      level: 'warn',
      message: suspensaSemRetomada
        ? 'A busca de pedidos estava parada desde a suspensão do computador (o Windows não avisou a volta) — religando.'
        : naoVoltouDaSuspensao
          ? 'A busca de pedidos não voltou depois da suspensão — religando.'
          : 'A busca de pedidos estava parada — religando.'
    })
    void this.resumeAfterWake()
  }

  /** Busca a fila agora — usado quando a impressora acabou de ser escolhida. */
  kick(): void {
    this.queueLoop.kick()
  }

  getInFlightClaimId(): string | null {
    return this.queueLoop.getInFlightClaimId()
  }

  async releaseInFlight(): Promise<void> {
    const id = this.queueLoop.getInFlightClaimId()
    if (!id) return
    await this.endpoints.release(id, {
      errorCode: 'AGENT_QUIT',
      errorMessage: 'Agente encerrado antes de concluir a impressão.'
    })
  }

  async clearToken(): Promise<void> {
    await this.tokens.clear()
  }
}
