import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentState } from './agentState'
import type { EstadoDaStore, InicioAutomatico, PaginaDoWindows } from '@shared/types'
import {
  APP_DO_PACOTE,
  EXE_DO_APP,
  TAREFA_DE_INICIO,
  TAREFA_DE_REABRIR,
  estadoDoInicio,
  inicioDesligado,
  lerAtualizacoes,
  lerMarca,
  podeAtualizarAgora,
  resultadoDaStore,
  ultimaImpressao,
  voltouAgora,
  type Atualizacoes,
  type MarcaDeAtualizacao
} from '@lib/windowsStore/regras'

const execFileAsync = promisify(execFile)
const SEIS_HORAS = 6 * 60 * 60_000

async function powershell(script: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }
  )
  return stdout
}

const ESPERAR = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 }",
  'function Esperar($op, [Type[]]$tipos) {',
  "  $nome = if ($tipos.Count -eq 2) { 'IAsyncOperationWithProgress`2' } else { 'IAsyncOperation`1' }",
  '  $m = ($asTask | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq $nome })[0].MakeGenericMethod($tipos)',
  '  $t = $m.Invoke($null, @($op))',
  '  $null = $t.Wait(-1)',
  '  $t.Result',
  '}'
]

const TAREFA = [
  '[void][Windows.ApplicationModel.StartupTask,Windows.ApplicationModel,ContentType=WindowsRuntime]',
  `$t = Esperar ([Windows.ApplicationModel.StartupTask]::GetAsync('${TAREFA_DE_INICIO}')) @([Windows.ApplicationModel.StartupTask])`
]

const LOJA = [
  '[void][Windows.Services.Store.StoreContext,Windows.Services.Store,ContentType=WindowsRuntime]',
  '$c = [Windows.Services.Store.StoreContext]::GetDefault()',
  '$u = Esperar ($c.GetAppAndOptionalStorePackageUpdatesAsync()) @([System.Collections.Generic.IReadOnlyList[Windows.Services.Store.StorePackageUpdate]])'
]

const RESULTADO =
  '@([Windows.Services.Store.StorePackageUpdateResult],[Windows.Services.Store.StorePackageUpdateStatus])'

export async function lerInicioAutomatico(ligarSeDesligadoPeloApp: boolean): Promise<InicioAutomatico> {
  const script = [
    ...ESPERAR,
    ...TAREFA,
    '$s = $t.State',
    ...(ligarSeDesligadoPeloApp
      ? [
          "if ($s -eq 'Disabled') { $s = Esperar ($t.RequestEnableAsync()) @([Windows.ApplicationModel.StartupTaskState]) }"
        ]
      : []),
    'Write-Output $s'
  ].join('\n')
  try {
    return estadoDoInicio(await powershell(script, 45_000))
  } catch {
    return 'desconhecido'
  }
}

async function desligarInicioAutomatico(): Promise<InicioAutomatico> {
  const script = [...ESPERAR, ...TAREFA, '$t.Disable()', 'Write-Output $t.State'].join('\n')
  try {
    return estadoDoInicio(await powershell(script, 45_000))
  } catch {
    return 'desconhecido'
  }
}

async function procurarAtualizacao(): Promise<Atualizacoes | null> {
  const script = [
    ...ESPERAR,
    ...LOJA,
    "Write-Output ('{0}|{1}' -f $u.Count, $c.CanSilentlyDownloadStorePackageUpdates)"
  ].join('\n')
  try {
    return lerAtualizacoes(await powershell(script, 60_000))
  } catch {
    return null
  }
}

async function baixarAtualizacao(): Promise<string> {
  const script = [
    ...ESPERAR,
    ...LOJA,
    "if ($u.Count -eq 0) { Write-Output 'Nenhuma'; exit }",
    `$r = Esperar ($c.TrySilentDownloadStorePackageUpdatesAsync($u)) ${RESULTADO}`,
    'Write-Output $r.OverallState'
  ].join('\n')
  return resultadoDaStore(await powershell(script, 45 * 60_000))
}

async function instalarAtualizacao(): Promise<string> {
  const script = [
    ...ESPERAR,
    ...LOJA,
    "if ($u.Count -eq 0) { Write-Output 'Nenhuma'; exit }",
    `$a = New-ScheduledTaskAction -Execute 'explorer.exe' -Argument 'shell:AppsFolder\\${APP_DO_PACOTE}'`,
    '$g = @((New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3)), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)))',
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable',
    `$null = Register-ScheduledTask -TaskName '${TAREFA_DE_REABRIR}' -Action $a -Trigger $g -Settings $s -Force`,
    `$r = Esperar ($c.TrySilentDownloadAndInstallStorePackageUpdatesAsync($u)) ${RESULTADO}`,
    'Write-Output $r.OverallState'
  ].join('\n')
  return resultadoDaStore(await powershell(script, 15 * 60_000))
}

async function apagarTarefaDeReabrir(): Promise<void> {
  try {
    await execFileAsync('schtasks.exe', ['/Delete', '/TN', TAREFA_DE_REABRIR, '/F'], {
      timeout: 20_000,
      windowsHide: true
    })
  } catch {
    /* a tarefa pode não existir */
  }
}

export function antigoInstalado(): boolean {
  const base = process.env['LOCALAPPDATA']
  return !!base && existsSync(join(base, 'Programs', 'venda-no-zap-print-agent', EXE_DO_APP))
}

export async function fecharAppAntigo(): Promise<number> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$n = 0',
    `Get-CimInstance Win32_Process -Filter "Name='${EXE_DO_APP}'" | ForEach-Object {`,
    "  if ($_.ExecutablePath -and $_.ExecutablePath -notlike '*\\WindowsApps\\*') { Stop-Process -Id $_.ProcessId -Force; $n++ }",
    '}',
    'Write-Output $n'
  ].join('\n')
  try {
    const linhas = (await powershell(script, 30_000)).trim().split(/\r?\n/)
    const n = Number.parseInt(linhas[linhas.length - 1] ?? '0', 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export function abrirConfiguracaoDoWindows(pagina: PaginaDoWindows): void {
  void shell.openExternal(pagina === 'aplicativos' ? 'ms-settings:appsfeatures' : 'ms-settings:startupapps')
}

function caminhoDaMarca(): string {
  return join(app.getPath('userData'), 'atualizacao-pela-store.json')
}

function apagarMarca(): void {
  try {
    unlinkSync(caminhoDaMarca())
  } catch {
    /* sem marca */
  }
}

let marcaDoInicio: MarcaDeAtualizacao | null | undefined

function marcaDeAtualizacao(): MarcaDeAtualizacao | null {
  if (marcaDoInicio === undefined) {
    let texto: string | null = null
    try {
      texto = readFileSync(caminhoDaMarca(), 'utf8')
    } catch {
      texto = null
    }
    marcaDoInicio = lerMarca(texto)
  }
  return marcaDoInicio
}

export function voltouDeAtualizacao(): boolean {
  return voltouAgora(marcaDeAtualizacao(), Date.now())
}

let instalando = false

export function instalandoAtualizacao(): boolean {
  return instalando
}

type DepsDaStore = {
  state: AgentState
  ocupado: () => boolean
  pendentesLocais: () => number
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

let depsDaStore: DepsDaStore | null = null
let ultimaConferenciaDoInicio = 0

function publicar(parcial: Partial<EstadoDaStore>): void {
  if (!depsDaStore) return
  const atual: EstadoDaStore = depsDaStore.state.get().windowsStore ?? {
    inicioAutomatico: 'desconhecido',
    antigoInstalado: false
  }
  depsDaStore.state.patch({ windowsStore: { ...atual, ...parcial } })
}

async function conferirInicio(): Promise<void> {
  if (!depsDaStore) return
  ultimaConferenciaDoInicio = Date.now()
  const estado = await lerInicioAutomatico(depsDaStore.state.get().preferences.autoStart)
  publicar({ inicioAutomatico: estado, antigoInstalado: antigoInstalado() })
}

export function reconferirAoFocar(): void {
  if (!depsDaStore) return
  publicar({ antigoInstalado: antigoInstalado() })
  const estado = depsDaStore.state.get().windowsStore?.inicioAutomatico ?? 'desconhecido'
  if (inicioDesligado(estado) && Date.now() - ultimaConferenciaDoInicio > 30_000) void conferirInicio()
}

export async function aplicarInicioAutomatico(ligar: boolean): Promise<void> {
  const estado = ligar ? await lerInicioAutomatico(true) : await desligarInicioAutomatico()
  publicar({ inicioAutomatico: estado })
  if (ligar && (estado === 'desligado_pelo_usuario' || estado === 'desligado_pela_politica')) {
    abrirConfiguracaoDoWindows('inicializacao')
  }
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let atualizando = false

async function cicloDeAtualizacao(deps: DepsDaStore): Promise<void> {
  if (atualizando) return
  atualizando = true
  try {
    const achou = await procurarAtualizacao()
    if (!achou || achou.quantas === 0) return
    if (!achou.emSilencio) {
      deps.log('warn', 'Há versão nova na Microsoft Store, mas o Windows não deixa instalar sem perguntar: ela entra quando o aplicativo for fechado.')
      return
    }
    deps.log('info', 'Versão nova na Microsoft Store: baixando em segundo plano.')
    const baixou = await baixarAtualizacao()
    if (baixou !== 'Completed') {
      deps.log('warn', `O download da versão nova pela Microsoft Store não terminou (${baixou || 'sem resposta'}).`)
      return
    }
    let quieto = false
    for (let i = 0; i < 24 && !quieto; i++) {
      quieto = podeAtualizarAgora({
        agora: Date.now(),
        ultimaImpressao: ultimaImpressao(deps.state.get().history),
        ocupado: deps.ocupado(),
        pendentesLocais: deps.pendentesLocais()
      })
      if (!quieto) await esperar(15 * 60_000)
    }
    if (!quieto) return
    deps.log('info', 'Instalando a versão nova da Microsoft Store: o aplicativo fecha e volta sozinho em alguns minutos.')
    writeFileSync(caminhoDaMarca(), JSON.stringify({ de: app.getVersion(), em: Date.now() }))
    instalando = true
    const resultado = await instalarAtualizacao()
    instalando = false
    apagarMarca()
    await apagarTarefaDeReabrir()
    deps.log(resultado === 'Completed' ? 'info' : 'warn', `Instalação pela Microsoft Store: ${resultado || 'sem resposta'}.`)
  } catch (err) {
    instalando = false
    apagarMarca()
    await apagarTarefaDeReabrir()
    deps.log('warn', `A atualização pela Microsoft Store falhou: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  } finally {
    atualizando = false
  }
}

export function iniciarRotinasDaStore(deps: DepsDaStore): void {
  depsDaStore = deps
  const marca = marcaDeAtualizacao()
  if (marca) {
    apagarMarca()
    void apagarTarefaDeReabrir()
    deps.log(
      'info',
      marca.de === app.getVersion()
        ? `O aplicativo voltou depois da atualização pela Microsoft Store, ainda na versão ${marca.de}.`
        : `Atualizado pela Microsoft Store: ${marca.de} → ${app.getVersion()}.`
    )
  }
  publicar({ antigoInstalado: antigoInstalado() })
  setTimeout(() => void conferirInicio(), 60_000)
  setInterval(() => void conferirInicio(), SEIS_HORAS)
  setTimeout(() => void cicloDeAtualizacao(deps), 10 * 60_000)
  setInterval(() => void cicloDeAtualizacao(deps), SEIS_HORAS)
}
