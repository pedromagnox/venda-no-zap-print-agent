// Várias impressoras no mesmo computador (1.14.0): qual config imprime cada pedido e os nomes de fábrica.
// Roda no Node 24 direto: node --test scripts/teste-varias-impressoras.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alvoDaImpressora,
  comCores,
  configDaImpressora,
  corDaImpressora,
  nomeDeFabrica,
  CHAVE_PRINCIPAL,
  CORES_DAS_IMPRESSORAS
} from '../src/shared/types.ts'

const principal = { type: 'windows_spooler', spoolerName: 'Termica Balcao', paperWidth: 80 }
const bar = { type: 'windows_spooler', spoolerName: 'Termica Bar', paperWidth: 80, printMode: 'raster' }
const snap = { printer: principal, extras: [{ chave: 'imp-1', config: bar }] }

test('pedido sem chave ou com a principal sai na principal', () => {
  assert.equal(configDaImpressora(snap), principal)
  assert.equal(configDaImpressora(snap, null), principal)
  assert.equal(configDaImpressora(snap, CHAVE_PRINCIPAL), principal)
})

test('pedido para a impressora a mais sai nela, com o modo dela', () => {
  assert.equal(configDaImpressora(snap, 'imp-1'), bar)
})

test('chave que não existe mais aqui (removida) cai na principal, para o pedido não se perder', () => {
  assert.equal(configDaImpressora(snap, 'imp-removida'), principal)
})

test('nomes de fábrica iguais aos do servidor: Balcão, Bar, 03, 04…', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(nomeDeFabrica), ['Balcão', 'Bar', '03', '04', '10'])
})

test('cada impressora a mais ganha uma cor livre e guarda a sua; a principal é sempre a laranja', () => {
  const sem = [1, 2, 3].map((n) => ({ chave: `imp-${n}`, config: bar }))
  assert.deepEqual(comCores(sem).map((e) => e.cor), [1, 2, 3])
  const semA2 = comCores(sem).filter((e) => e.chave !== 'imp-2')
  assert.deepEqual(comCores(semA2).map((e) => e.cor), [1, 3])
  const comNova = comCores([...semA2, { chave: 'imp-4', config: bar }])
  assert.deepEqual(comNova.map((e) => e.cor), [1, 3, 2])
  assert.deepEqual(comCores([{ chave: 'a', config: bar, cor: 3 }, { chave: 'b', config: bar, cor: 3 }]).map((e) => e.cor), [3, 1])
  assert.equal(corDaImpressora(comNova, CHAVE_PRINCIPAL), CORES_DAS_IMPRESSORAS[0])
  assert.equal(corDaImpressora(comNova, 'imp-4'), CORES_DAS_IMPRESSORAS[2])
})

test('a mesma impressora é o mesmo alvo, sem diferença de maiúscula ou espaço', () => {
  assert.equal(alvoDaImpressora({ type: 'windows_spooler', spoolerName: ' Termica Bar ', paperWidth: 80 }), 'windows:termica bar')
  assert.equal(alvoDaImpressora({ type: 'network', host: '192.168.0.10', paperWidth: 80 }), 'rede:192.168.0.10:9100')
  assert.equal(alvoDaImpressora({ type: 'windows_spooler', spoolerName: '', paperWidth: 80 }), null)
  assert.equal(alvoDaImpressora({ type: 'network', host: '  ', paperWidth: 80 }), null)
})
