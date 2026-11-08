// Testes das regras do app da Microsoft Store (src/lib/windowsStore/regras.ts):
// início com o Windows, atualização silenciosa e app antigo.
//   node --test scripts/teste-windows-store.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estadoDoInicio,
  inicioLigado,
  inicioDesligado,
  lerAtualizacoes,
  resultadoDaStore,
  doAppAntigo,
  podeAtualizarAgora,
  ultimaImpressao,
  lerMarca,
  voltouAgora,
  QUIETO_MS
} from '../src/lib/windowsStore/regras.ts'

test('estado do início com o Windows vem da última linha do PowerShell', () => {
  assert.equal(estadoDoInicio('Enabled\r\n'), 'ligado')
  assert.equal(estadoDoInicio('aviso qualquer\r\nDisabledByUser\r\n'), 'desligado_pelo_usuario')
  assert.equal(estadoDoInicio('DisabledByPolicy'), 'desligado_pela_politica')
  assert.equal(estadoDoInicio('EnabledByPolicy'), 'ligado_pela_politica')
  assert.equal(estadoDoInicio('Disabled'), 'desligado')
  assert.equal(estadoDoInicio(''), 'desconhecido')
  assert.equal(estadoDoInicio('Exception calling "GetAsync"'), 'desconhecido')
})

test('ligado e desligado', () => {
  assert.equal(inicioLigado('ligado'), true)
  assert.equal(inicioLigado('ligado_pela_politica'), true)
  assert.equal(inicioLigado('desconhecido'), false)
  assert.equal(inicioDesligado('desligado_pelo_usuario'), true)
  assert.equal(inicioDesligado('desconhecido'), false)
})

test('atualizações da Store: quantas e se instala em silêncio', () => {
  assert.deepEqual(lerAtualizacoes('1|True\r\n'), { quantas: 1, emSilencio: true })
  assert.deepEqual(lerAtualizacoes('0|False'), { quantas: 0, emSilencio: false })
  assert.equal(lerAtualizacoes('erro'), null)
  assert.equal(resultadoDaStore('Completed\r\n'), 'Completed')
  assert.equal(resultadoDaStore(''), '')
})

test('app antigo = o .exe fora da pasta da Store', () => {
  assert.equal(doAppAntigo('C:\\Users\\pedro\\AppData\\Local\\Programs\\venda-no-zap-print-agent\\Venda no Zap Print Agent.exe'), true)
  assert.equal(
    doAppAntigo('C:\\Program Files\\WindowsApps\\VendanoZap.VendanoZapImpresso_1.13.0.0_x64__6h62scjbd05x8\\app\\Venda no Zap Print Agent.exe'),
    false
  )
  assert.equal(doAppAntigo(undefined), false)
  assert.equal(doAppAntigo('C:\\Windows\\explorer.exe'), false)
})

test('só instala a versão nova com o app quieto', () => {
  const agora = Date.parse('2026-11-08T15:00:00Z')
  assert.equal(podeAtualizarAgora({ agora, ultimaImpressao: null, ocupado: false, pendentesLocais: 0 }), true)
  assert.equal(podeAtualizarAgora({ agora, ultimaImpressao: agora - QUIETO_MS, ocupado: false, pendentesLocais: 0 }), true)
  assert.equal(podeAtualizarAgora({ agora, ultimaImpressao: agora - 60_000, ocupado: false, pendentesLocais: 0 }), false)
  assert.equal(podeAtualizarAgora({ agora, ultimaImpressao: null, ocupado: true, pendentesLocais: 0 }), false)
  assert.equal(podeAtualizarAgora({ agora, ultimaImpressao: null, ocupado: false, pendentesLocais: 1 }), false)
})

test('última impressão do histórico', () => {
  assert.equal(ultimaImpressao([]), null)
  assert.equal(
    ultimaImpressao([{ printedAt: '2026-11-08T10:00:00Z' }, { printedAt: '2026-11-08T12:00:00Z' }, { printedAt: 'x' }]),
    Date.parse('2026-11-08T12:00:00Z')
  )
})

test('marca de atualização: lê e vale por 20 minutos', () => {
  assert.equal(lerMarca(null), null)
  assert.equal(lerMarca('{quebrado'), null)
  const marca = lerMarca('{"de":"1.13.0","em":1000}')
  assert.deepEqual(marca, { de: '1.13.0', em: 1000 })
  assert.equal(voltouAgora(marca, 1000 + 60_000), true)
  assert.equal(voltouAgora(marca, 1000 + 21 * 60_000), false)
  assert.equal(voltouAgora(null, 5), false)
})
