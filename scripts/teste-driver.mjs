// Modo «pelo driver do Windows» (1.13.3): o cupom em imagem (GS v 0) vira página PNG para o driver.
// Roda no Node 24 direto: node --test scripts/teste-driver.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { paginasDoRaster, pngDaPagina, paginaParaODriver } from '../src/lib/printer/rasterParaImagem.ts'

const banda = (wb, h, preenchido) => [0x1d, 0x76, 0x30, 0x00, wb, 0, h, 0, ...Array(wb * h).fill(preenchido)]
const corte = [0x1d, 0x56, 66, 0]

test('bandas viram uma página; avanço no fim some; corte fecha a página', () => {
  const bytes = Uint8Array.from([0x1b, 0x40, ...banda(2, 3, 0xff), 0x0a, ...banda(1, 2, 0x80), 0x0a, 0x0a, ...corte])
  const [p, ...resto] = paginasDoRaster(bytes)
  assert.equal(resto.length, 0)
  assert.equal(p.largura, 16)
  assert.equal(p.altura, 3 + 24 + 2)
  assert.equal(p.bits[0], 0xff)
  assert.equal(p.bits[(3 + 24) * 2], 0x80)
  assert.equal(p.bits[(3 + 24) * 2 + 1], 0x00)
})

test('dois cortes = duas páginas (cartões de QR, cópias)', () => {
  const bytes = Uint8Array.from([...banda(1, 1, 0xff), ...corte, ...banda(1, 2, 0xff), ...corte])
  assert.deepEqual(paginasDoRaster(bytes).map((p) => p.altura), [1, 2])
})

test('sem imagem não vira página', () => {
  assert.equal(paginasDoRaster(Uint8Array.from([0x1b, 0x40, 0x0a, ...corte])).length, 0)
})

test('PNG: assinatura, tamanho e preto onde o bit está ligado', () => {
  const [p] = paginasDoRaster(Uint8Array.from(banda(1, 2, 0xf0)))
  const png = pngDaPagina(p)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 8)
  assert.equal(png.readUInt32BE(20), 2)
  const idat = png.indexOf('IDAT')
  const tamanho = png.readUInt32BE(idat - 4)
  const linhas = inflateSync(png.subarray(idat + 4, idat + 4 + tamanho))
  assert.deepEqual([...linhas], [0, 0x0f, 0, 0x0f])
})

test('página: 576 pontos = papel de 80 mm, 384 = 58 mm, imagem no tamanho real (8 pontos/mm)', () => {
  const p80 = paginaParaODriver({ largura: 576, altura: 800, bits: new Uint8Array(72 * 800) })
  assert.equal(p80.papelMm, 80)
  assert.equal(p80.alturaMm, 106)
  assert.match(p80.html, /@page\{size:80mm 106mm;margin:0\}/)
  assert.match(p80.html, /width:72mm;height:100mm/)
  assert.match(p80.html, /src="data:image\/png;base64,/)
  assert.equal(paginaParaODriver({ largura: 384, altura: 8, bits: new Uint8Array(48 * 8) }).papelMm, 58)
})
