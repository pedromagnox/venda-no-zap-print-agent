// Várias impressoras no mesmo computador (1.14.0): qual config imprime cada pedido e os nomes de fábrica.
// Roda no Node 24 direto: node --test scripts/teste-varias-impressoras.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configDaImpressora, nomeDeFabrica, CHAVE_PRINCIPAL } from '../src/shared/types.ts'

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
