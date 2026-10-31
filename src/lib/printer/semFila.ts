import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ImpressoraSemFila, InstalarImpressoraResult } from '@shared/types'

// v1.12.0: acha a térmica que o Windows enxerga mas que ainda não tem
// impressora (fila) criada, e cria a fila «Generic / Text Only» na porta certa.
// É o passo a passo que o lojista fazia à mão (impressora_usb /
// impressora_bluetooth_windows), sem escolher porta.
//
// A impressão continua passando pela fila do Windows: a térmica segue dividida
// com iFood e outros programas (o spooler organiza a fila entre eles).
//
// Tudo lido pelo `reg query`, sem PowerShell: nos PCs fracos o PowerShell não
// responde na 1ª abertura (inventário em branco), e era justamente esse lojista
// que travava no passo da porta.
//
// Histórico: a v1.6–1.8 tinha um auto-instalador só de USB pelo PowerShell
// (Get-PnpDevice + Add-Printer), aposentado na v1.10.5 junto com o YICHIP.

const execFileAsync = promisify(execFile)
const REG_TIMEOUT_MS = 10_000

// Serviço Serial Port Profile (SPP) — é por ele que a térmica Bluetooth vira COM.
const SPP_UUID = '{00001101-0000-1000-8000-00805f9b34fb}'
// Interface de dispositivo do usbprint (a USB001, USB002…).
const USBPRINT_GUID = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'

const KEY_BTHENUM = 'HKLM\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM'
const KEY_BT_DEVICES = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices'
const KEY_USBPRINT = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\${USBPRINT_GUID}`
const KEY_PRINTERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers'

export const GENERIC_TEXT_ONLY = 'Generic / Text Only'

// ---------------------------------------------------------------------------
// Parser da saída do `reg query /s`
// ---------------------------------------------------------------------------

export type RegValue = { name: string; type: string; data: string }
export type RegKey = { path: string; values: RegValue[] }

/** Lê a saída do `reg query … /s`. Linha que começa com HKEY_ abre uma chave;
 *  linha indentada é «nome    TIPO    dado» (o nome pode ter espaço, por isso o
 *  corte é pelo TIPO). O rodapé localizado («Fim da pesquisa…») é ignorado. */
export function parseRegQuery(stdout: string): RegKey[] {
  const keys: RegKey[] = []
  let current: RegKey | null = null
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    if (/^HKEY_/i.test(line)) {
      current = { path: line, values: [] }
      keys.push(current)
      continue
    }
    if (!current || !/^\s/.test(line)) continue
    const m = /^\s+(.*?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/.exec(line)
    if (!m) continue
    current.values.push({ name: m[1]!.trim(), type: m[2]!, data: (m[3] ?? '').trim() })
  }
  return keys
}

function valueOf(key: RegKey, name: string): string | null {
  const v = key.values.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return v ? v.data : null
}

function dword(data: string | null): number | null {
  if (!data) return null
  const n = Number.parseInt(data, data.toLowerCase().startsWith('0x') ? 16 : 10)
  return Number.isFinite(n) ? n : null
}

/** REG_BINARY do nome do aparelho Bluetooth: hex de UTF-8 terminado em 00. */
export function decodeRegBinaryName(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  const bytes: number[] = []
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const b = Number.parseInt(clean.slice(i, i + 2), 16)
    if (b === 0) break
    bytes.push(b)
  }
  return Buffer.from(bytes).toString('utf8').trim()
}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

export type BluetoothSaida = { mac: string; port: string }

/** Portas COM de SAÍDA do SPP. A instância de saída leva o endereço do aparelho
 *  remoto (…&DC0D30F859AB_C00000000); a de ENTRADA leva 000000000000. */
export function parseBluetoothOutgoing(keys: RegKey[]): BluetoothSaida[] {
  const out: BluetoothSaida[] = []
  for (const k of keys) {
    if (!k.path.toLowerCase().includes(SPP_UUID)) continue
    const port = valueOf(k, 'PortName')
    if (!port || !/^COM\d+$/i.test(port)) continue
    const m = /&([0-9A-F]{12})_[0-9A-F]+\\Device Parameters$/i.exec(k.path)
    if (!m) continue
    const mac = m[1]!.toLowerCase()
    if (mac === '000000000000') continue
    out.push({ mac, port: port.toUpperCase() })
  }
  return out
}

/** Nome de cada aparelho pareado, pelo endereço (chave = mac em minúsculas). */
export function parseBluetoothNames(keys: RegKey[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const k of keys) {
    const m = /\\Devices\\([0-9a-f]{12})$/i.exec(k.path)
    if (!m) continue
    const raw = k.values.find((v) => v.name === 'Name')
    if (!raw) continue
    const name = raw.type === 'REG_BINARY' ? decodeRegBinaryName(raw.data) : raw.data
    if (name) names.set(m[1]!.toLowerCase(), name)
  }
  return names
}

// ---------------------------------------------------------------------------
// USB (usbprint)
// ---------------------------------------------------------------------------

export type UsbPrintPort = { port: string; description: string | null; vid: string | null; present: boolean }

/** Portas USB00x que o usbprint criou. Cada interface tem `#\Device Parameters`
 *  (Base Name + Port Number + Port Description) e, se o aparelho está ligado
 *  agora, `#\Control` com Linked = 1. */
export function parseUsbPrintPorts(keys: RegKey[]): UsbPrintPort[] {
  type Acc = { base?: string; num?: number; desc?: string; linked?: boolean; vid?: string }
  const byIface = new Map<string, Acc>()
  for (const k of keys) {
    const m = /\\(##\?#USB#[^\\]+)\\#\\(Device Parameters|Control)$/i.exec(k.path)
    if (!m) continue
    const iface = m[1]!
    const acc = byIface.get(iface) ?? {}
    const vid = /VID_([0-9A-F]{4})/i.exec(iface)
    if (vid) acc.vid = vid[1]!.toUpperCase()
    if (m[2]!.toLowerCase() === 'device parameters') {
      acc.base = valueOf(k, 'Base Name') ?? acc.base
      acc.num = dword(valueOf(k, 'Port Number')) ?? acc.num
      acc.desc = valueOf(k, 'Port Description') ?? acc.desc
    } else {
      acc.linked = dword(valueOf(k, 'Linked')) === 1
    }
    byIface.set(iface, acc)
  }
  const out: UsbPrintPort[] = []
  for (const acc of byIface.values()) {
    if (!acc.base || acc.num === undefined) continue
    out.push({
      port: `${acc.base.toUpperCase()}${String(acc.num).padStart(3, '0')}`,
      description: acc.desc?.trim() || null,
      vid: acc.vid ?? null,
      present: acc.linked === true
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Filas existentes
// ---------------------------------------------------------------------------

/** Porta → nomes das filas que já usam essa porta. «COM3:» e «COM3» viram a
 *  mesma chave. Uma fila pode listar várias portas separadas por vírgula. */
export function parsePrinterPorts(keys: RegKey[]): Map<string, string[]> {
  const byPort = new Map<string, string[]>()
  for (const k of keys) {
    const m = /\\Print\\Printers\\([^\\]+)$/i.exec(k.path)
    if (!m) continue
    const ports = valueOf(k, 'Port')
    if (!ports) continue
    for (const p of ports.split(',')) {
      const port = normalizePort(p)
      if (!port) continue
      byPort.set(port, [...(byPort.get(port) ?? []), m[1]!])
    }
  }
  return byPort
}

export function normalizePort(port: string): string {
  return port.trim().replace(/:$/, '').toUpperCase()
}

// ---------------------------------------------------------------------------
// Junta tudo
// ---------------------------------------------------------------------------

export function montarSemFila(input: {
  btOutgoing: BluetoothSaida[]
  btNames: Map<string, string>
  usbPorts: UsbPrintPort[]
  printersByPort: Map<string, string[]>
}): ImpressoraSemFila[] {
  const out: ImpressoraSemFila[] = []
  const vistos = new Set<string>()
  for (const bt of input.btOutgoing) {
    // Só aparelho que continua pareado (a chave em BTHPORT some ao despareá-lo).
    const name = input.btNames.get(bt.mac)
    if (!name) continue
    if (input.printersByPort.has(bt.port) || vistos.has(bt.port)) continue
    vistos.add(bt.port)
    out.push({
      kind: 'bluetooth',
      port: bt.port,
      label: name,
      detail: `Bluetooth · pareada (${bt.port})`,
      suggestedQueueName: nomeDeFila(name),
      vid: null
    })
  }
  for (const usb of input.usbPorts) {
    if (!usb.present) continue
    if (input.printersByPort.has(usb.port) || vistos.has(usb.port)) continue
    vistos.add(usb.port)
    const label = usb.description || 'Impressora no cabo USB'
    out.push({
      kind: 'usb',
      port: usb.port,
      label,
      detail: `Cabo USB · sem driver (${usb.port})`,
      suggestedQueueName: nomeDeFila(usb.description ? usb.description : `USB ${usb.port}`),
      vid: usb.vid
    })
  }
  return out
}

/** Nome da fila que vamos criar: «Termica <aparelho>», só com caracteres que o
 *  printui aceita sem escape e com até 60 caracteres. */
export function nomeDeFila(base: string): string {
  const limpo = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _().-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `Termica ${limpo || 'Venda no Zap'}`.slice(0, 60).trim()
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function regQuery(key: string, extra: string[] = []): Promise<RegKey[]> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/s', ...extra], {
      timeout: REG_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    })
    return parseRegQuery(stdout)
  } catch (err) {
    // `reg query` sai com código 1 quando a chave não existe (PC sem
    // Bluetooth, sem nenhuma USB00x). Isso é «nada encontrado», não erro.
    const stdout = (err as { stdout?: string }).stdout
    return typeof stdout === 'string' ? parseRegQuery(stdout) : []
  }
}

// Só para ver a tela no Linux (scripts/foto-sem-fila.mjs): no Windows nunca
// entra, porque exige plataforma diferente de win32.
function fakeAtivo(): boolean {
  return process.platform !== 'win32' && process.env.PRINT_AGENT_FAKE_SEM_FILA === '1'
}

function listaFake(): ImpressoraSemFila[] {
  return montarSemFila({
    btOutgoing: [{ mac: 'dc0d30f859ab', port: 'COM3' }],
    btNames: new Map([['dc0d30f859ab', 'KPrinter_ab28']]),
    usbPorts: [{ port: 'USB001', description: 'ELGIN i9', vid: '20D1', present: true }],
    printersByPort: new Map()
  })
}

let ultimoDiagnostico = ''

/** Resumo da última busca, para o log. */
export function diagnosticoDaBusca(): string {
  return ultimoDiagnostico
}

export async function listarSemFila(): Promise<ImpressoraSemFila[]> {
  if (fakeAtivo()) return listaFake()
  if (process.platform !== 'win32') return []
  const [bthenum, btDevices, usbprint, printers] = await Promise.all([
    regQuery(KEY_BTHENUM, ['/v', 'PortName']),
    regQuery(KEY_BT_DEVICES, ['/v', 'Name']),
    regQuery(KEY_USBPRINT),
    regQuery(KEY_PRINTERS, ['/v', 'Port'])
  ])
  const btOutgoing = parseBluetoothOutgoing(bthenum)
  const btNames = parseBluetoothNames(btDevices)
  const usbPorts = parseUsbPrintPorts(usbprint)
  const printersByPort = parsePrinterPorts(printers)
  const itens = montarSemFila({ btOutgoing, btNames, usbPorts, printersByPort })
  // Uma linha para o log (sai no «Enviar logs ao suporte»): sem ela, quando a
  // impressora não aparece, não dá para saber de longe em que passo parou.
  ultimoDiagnostico =
    `Bluetooth: ${btOutgoing.length} porta(s) de saída (${btOutgoing.map((b) => `${b.port}${btNames.has(b.mac) ? '' : ' sem nome'}`).join(', ') || '—'}), ` +
    `${btNames.size} aparelho(s) pareado(s); USB: ${usbPorts.map((u) => `${u.port}${u.present ? '' : ' desligada'}`).join(', ') || 'nenhuma porta'}; ` +
    `filas em ${[...printersByPort.keys()].join(', ') || '—'}; sem fila: ${itens.map((i) => i.port).join(', ') || 'nenhuma'}`
  return itens
}


async function filaExiste(nome: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await execFileAsync('reg', ['query', `${KEY_PRINTERS}\\${nome}`], {
      timeout: REG_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

export function printuiArgs(nome: string, port: string): string[] {
  const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  // COM entra no spooler com dois-pontos («COM3:»); USB00x, sem.
  const portaSpooler = /^COM\d+$/i.test(port) ? `${port.toUpperCase()}:` : port.toUpperCase()
  return [
    'printui.dll,PrintUIEntry',
    '/if',
    '/b', nome,
    '/r', portaSpooler,
    '/m', GENERIC_TEXT_ONLY,
    '/f', `${windir}\\inf\\ntprint.inf`,
    '/u',
    '/q'
  ]
}

/** Cria a fila «Generic / Text Only» na porta. Tenta primeiro sem pedir nada;
 *  se o Windows não deixar, pede a permissão de administrador (janela do
 *  Windows com «Sim»). Confere pelo registro se a fila apareceu. */
export async function criarFilaGenerica(
  port: string,
  queueName: string,
  deps: { elevate?: (file: string, args: string[]) => Promise<void> } = {}
): Promise<InstalarImpressoraResult> {
  if (fakeAtivo()) {
    await new Promise((r) => setTimeout(r, 1500))
    return { ok: true, queueName, elevated: true }
  }
  if (process.platform !== 'win32') return { ok: false, error: 'Só no Windows.' }
  if (!/^(COM\d+|USB\d{3})$/i.test(port)) return { ok: false, error: `Porta inválida: ${port}` }
  if (!/^[A-Za-z0-9 _().-]{1,60}$/.test(queueName)) {
    return { ok: false, error: `Nome de impressora inválido: ${queueName}` }
  }
  if (await filaExiste(queueName)) return { ok: true, queueName, elevated: false }

  const args = printuiArgs(queueName, port)
  try {
    await execFileAsync('rundll32', args, { timeout: 60_000, windowsHide: true })
  } catch {
    /* sem permissão costuma sair calado (/q); quem decide é o registro */
  }
  if (await filaExiste(queueName)) return { ok: true, queueName, elevated: false }

  try {
    await (deps.elevate ?? runElevated)('rundll32.exe', args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Permissão do Windows não concedida (${msg.slice(0, 200)})` }
  }
  if (await filaExiste(queueName)) return { ok: true, queueName, elevated: true }
  return { ok: false, error: 'O Windows não criou a impressora.' }
}

/** Roda como administrador (janela do UAC). O PowerShell aqui só abre o
 *  processo — não faz consulta WMI, que é o que trava nos PCs fracos. */
async function runElevated(file: string, args: string[]): Promise<void> {
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comandoElevado(file, args)], {
    timeout: 180_000,
    windowsHide: true
  })
}

/** Linha do PowerShell que abre `file args` como administrador. Os argumentos
 *  com espaço vão entre aspas duplas; a lista toda vai entre aspas simples do
 *  PowerShell (aspa simples dobrada). */
export function comandoElevado(file: string, args: string[]): string {
  const linha = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
  const ps = (x: string): string => `'${x.replace(/'/g, "''")}'`
  return `Start-Process -FilePath ${ps(file)} -ArgumentList ${ps(linha)} -Verb RunAs -Wait -WindowStyle Hidden`
}
