// Testes do achador de impressora sem fila (src/lib/printer/semFila.ts), com
// saídas do `reg query` no formato do Windows em pt-BR (CRLF + rodapé
// localizado). Roda no Node 24 direto (tira os tipos do .ts):
//   node --test scripts/teste-sem-fila.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRegQuery,
  parseBluetoothOutgoing,
  parseBluetoothNames,
  parseUsbPrintPorts,
  parsePrinterPorts,
  montarSemFila,
  nomeDeFila,
  decodeRegBinaryName,
  comandoElevado,
  printuiArgs
} from '../src/lib/printer/semFila.ts'

const crlf = (s) => s.replace(/\n/g, '\r\n')
const hex = (s) => Buffer.from(s + '\0', 'utf8').toString('hex').toUpperCase()
const SPP = '{00001101-0000-1000-8000-00805f9b34fb}'
const G = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'
const DC = `HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\${G}`

const BTHENUM = crlf(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM\\${SPP}_LOCALMFG&0000\\7&2a5f3c1d&0&000000000000_00000004\\Device Parameters
    PortName    REG_SZ    COM4

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM\\${SPP}_LOCALMFG&0002\\7&1d4d8b6d&0&DC0D30F859AB_C00000000\\Device Parameters
    PortName    REG_SZ    COM3

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM\\${SPP}_LOCALMFG&0002\\7&1d4d8b6d&0&66AABBCCDDEE_C00000000\\Device Parameters
    PortName    REG_SZ    COM5

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM\\${SPP}_LOCALMFG&0002\\7&1d4d8b6d&0&001122334455_C00000000\\Device Parameters
    PortName    REG_SZ    COM9

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\BTHENUM\\{0000110b-0000-1000-8000-00805f9b34fb}_LOCALMFG&0002\\7&aa&0&A1B2C3D4E5F6_C00000000\\Device Parameters
    PortName    REG_SZ    COM7

Fim da pesquisa: 5 correspondência(s) encontrada(s).
`)

const BT_DEVICES = crlf(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\dc0d30f859ab
    Name    REG_BINARY    ${hex('KPrinter_ab28')}

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\66aabbccddee
    Name    REG_BINARY    ${hex('MPT-II_30C6')}

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\a1b2c3d4e5f6
    Name    REG_BINARY    ${hex('Fone JBL')}

Fim da pesquisa: 3 correspondência(s) encontrada(s).
`)

function usbIface(vidPid, inst, { num, desc, linked }) {
  const base = `${DC}\\##?#USB#${vidPid}#${inst}#${G}`
  return `
${base}
    DeviceInstance    REG_SZ    USB\\${vidPid}\\${inst}

${base}\\#
    SymbolicLink    REG_SZ    \\\\?\\USB#${vidPid}#${inst}#${G}
${linked === undefined ? '' : `
${base}\\#\\Control
    ReferenceCount    REG_DWORD    0x1
    Linked    REG_DWORD    ${linked ? '0x1' : '0x0'}
`}
${base}\\#\\Device Parameters
    Port Number    REG_DWORD    ${'0x' + num.toString(16)}
    Base Name    REG_SZ    USB
    Port Description    REG_SZ    ${desc}
    recyclable    REG_DWORD    0x1
`
}

const USBPRINT = crlf(
  `\n${DC}\n` +
    usbIface('VID_0416&PID_5011', '5&16e1a2f&0&2', { num: 1, desc: 'POS80 Printer USB', linked: true }) +
    usbIface('VID_20D1&PID_7008', '5&16e1a2f&0&3', { num: 2, desc: 'ELGIN i9', linked: undefined }) +
    usbIface('VID_0FE6&PID_811E', '5&16e1a2f&0&4', { num: 3, desc: 'Impressora de etiqueta', linked: true }) +
    usbIface('VID_20D1&PID_7008', '6&2b&0&1', { num: 10, desc: 'ELGIN i9', linked: true }) +
    '\nFim da pesquisa: 9 correspondência(s) encontrada(s).\n'
)

const PRINTERS = crlf(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\Microsoft Print to PDF
    Port    REG_SZ    PORTPROMPT:

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\Etiquetas
    Port    REG_SZ    USB003

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\Termica antiga
    Port    REG_SZ    COM9:

Fim da pesquisa: 3 correspondência(s) encontrada(s).
`)

test('parseRegQuery: chave, valor com espaço no nome e rodapé localizado', () => {
  const keys = parseRegQuery(USBPRINT)
  const dp = keys.find((k) => k.path.endsWith('&0&2#' + G + '\\#\\Device Parameters'))
  assert.ok(dp)
  assert.deepEqual(
    dp.values.map((v) => [v.name, v.type, v.data]),
    [
      ['Port Number', 'REG_DWORD', '0x1'],
      ['Base Name', 'REG_SZ', 'USB'],
      ['Port Description', 'REG_SZ', 'POS80 Printer USB'],
      ['recyclable', 'REG_DWORD', '0x1']
    ]
  )
  assert.ok(!keys.some((k) => k.path.startsWith('Fim')))
})

test('Bluetooth: só a porta de SAÍDA do SPP, nunca a de entrada nem outro serviço', () => {
  const out = parseBluetoothOutgoing(parseRegQuery(BTHENUM))
  assert.deepEqual(out, [
    { mac: 'dc0d30f859ab', port: 'COM3' },
    { mac: '66aabbccddee', port: 'COM5' },
    { mac: '001122334455', port: 'COM9' }
  ])
})

test('Bluetooth: nome do aparelho vem do REG_BINARY em UTF-8', () => {
  const names = parseBluetoothNames(parseRegQuery(BT_DEVICES))
  assert.equal(names.get('dc0d30f859ab'), 'KPrinter_ab28')
  assert.equal(names.get('66aabbccddee'), 'MPT-II_30C6')
  assert.equal(decodeRegBinaryName('4D50542D49490000FFFF'), 'MPT-II')
})

test('USB: porta = Base Name + número com 3 dígitos; presente só com Linked = 1', () => {
  const ports = parseUsbPrintPorts(parseRegQuery(USBPRINT))
  assert.deepEqual(
    ports.map((p) => [p.port, p.description, p.vid, p.present]),
    [
      ['USB001', 'POS80 Printer USB', '0416', true],
      ['USB002', 'ELGIN i9', '20D1', false],
      ['USB003', 'Impressora de etiqueta', '0FE6', true],
      ['USB010', 'ELGIN i9', '20D1', true]
    ]
  )
})

test('Filas existentes: «COM9:» e «COM9» são a mesma porta', () => {
  const byPort = parsePrinterPorts(parseRegQuery(PRINTERS))
  assert.deepEqual(byPort.get('COM9'), ['Termica antiga'])
  assert.deepEqual(byPort.get('USB003'), ['Etiquetas'])
  assert.ok(byPort.has('PORTPROMPT'))
})

test('Junta tudo: pareada sem fila + USB ligada sem fila; exclui o que já tem fila, desligado e despareado', () => {
  const lista = montarSemFila({
    btOutgoing: parseBluetoothOutgoing(parseRegQuery(BTHENUM)),
    btNames: parseBluetoothNames(parseRegQuery(BT_DEVICES)),
    usbPorts: parseUsbPrintPorts(parseRegQuery(USBPRINT)),
    printersByPort: parsePrinterPorts(parseRegQuery(PRINTERS))
  })
  assert.deepEqual(
    lista.map((i) => [i.kind, i.port, i.label, i.suggestedQueueName, i.vid]),
    [
      // COM9 (001122334455) já tem «Termica antiga»; COM7 é fone (não SPP).
      ['bluetooth', 'COM3', 'KPrinter_ab28', 'Termica KPrinter_ab28', null],
      ['bluetooth', 'COM5', 'MPT-II_30C6', 'Termica MPT-II_30C6', null],
      // USB002 desligada; USB003 já tem fila.
      ['usb', 'USB001', 'POS80 Printer USB', 'Termica POS80 Printer USB', '0416'],
      ['usb', 'USB010', 'ELGIN i9', 'Termica ELGIN i9', '20D1']
    ]
  )
})

test('Bluetooth que tem porta mas foi despareado (sem nome em BTHPORT) não aparece', () => {
  const lista = montarSemFila({
    btOutgoing: [{ mac: 'ffffffffffff', port: 'COM11' }],
    btNames: new Map(),
    usbPorts: [],
    printersByPort: new Map()
  })
  assert.deepEqual(lista, [])
})

test('Nome da fila: sem acento nem símbolo, até 60 caracteres', () => {
  assert.equal(nomeDeFila('Impressão Térmica ★ 58mm'), 'Termica Impressao Termica 58mm')
  assert.equal(nomeDeFila('🖨'), 'Termica Venda no Zap')
  assert.ok(nomeDeFila('x'.repeat(200)).length <= 60)
  assert.match(nomeDeFila('MPT-II_30C6 (2)'), /^[A-Za-z0-9 _().-]+$/)
})

test('printui: COM com dois-pontos, USB sem; driver Generic / Text Only', () => {
  const com = printuiArgs('Termica KPrinter_ab28', 'COM3')
  assert.deepEqual(com.slice(0, 6), ['printui.dll,PrintUIEntry', '/if', '/b', 'Termica KPrinter_ab28', '/r', 'COM3:'])
  assert.ok(com.includes('Generic / Text Only'))
  assert.equal(printuiArgs('X', 'usb001')[5], 'USB001')
})

test('Comando elevado: argumentos com espaço entre aspas, aspa simples dobrada', () => {
  const cmd = comandoElevado('rundll32.exe', ['printui.dll,PrintUIEntry', '/b', "Termica D'Ajuda", '/m', 'Generic / Text Only'])
  assert.equal(
    cmd,
    `Start-Process -FilePath 'rundll32.exe' -ArgumentList 'printui.dll,PrintUIEntry /b "Termica D''Ajuda" /m "Generic / Text Only"' -Verb RunAs -Wait -WindowStyle Hidden`
  )
})
