import { deflateSync } from 'node:zlib'

export type PaginaRaster = { largura: number; altura: number; bits: Uint8Array }

const PONTOS_POR_MM = 8
const PONTOS_DO_AVANCO = 24

type Pedaco = { tipo: 'imagem'; wb: number; h: number; dados: Uint8Array } | { tipo: 'avanco' }

export function paginasDoRaster(bytes: Uint8Array): PaginaRaster[] {
  const paginas: PaginaRaster[] = []
  let pedacos: Pedaco[] = []
  const fechar = (): void => {
    if (pedacos.some((p) => p.tipo === 'imagem')) paginas.push(montarPagina(pedacos))
    pedacos = []
  }
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]!
    if (b === 0x1b && bytes[i + 1] === 0x40) {
      i += 2
    } else if (b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      const wb = (bytes[i + 4] ?? 0) | ((bytes[i + 5] ?? 0) << 8)
      const h = (bytes[i + 6] ?? 0) | ((bytes[i + 7] ?? 0) << 8)
      const inicio = i + 8
      const fim = Math.min(bytes.length, inicio + wb * h)
      if (wb > 0 && h > 0) pedacos.push({ tipo: 'imagem', wb, h, dados: bytes.subarray(inicio, fim) })
      i = inicio + wb * h
    } else if (b === 0x0a) {
      pedacos.push({ tipo: 'avanco' })
      i += 1
    } else if (b === 0x1d && bytes[i + 1] === 0x56) {
      const m = bytes[i + 2]
      i += m === 65 || m === 66 ? 4 : 3
      fechar()
    } else {
      i += 1
    }
  }
  fechar()
  return paginas
}

function montarPagina(pedacos: Pedaco[]): PaginaRaster {
  while (pedacos.length && pedacos[pedacos.length - 1]!.tipo === 'avanco') pedacos.pop()
  let wbMax = 0
  let altura = 0
  for (const p of pedacos) {
    if (p.tipo === 'imagem') {
      wbMax = Math.max(wbMax, p.wb)
      altura += p.h
    } else {
      altura += PONTOS_DO_AVANCO
    }
  }
  const bits = new Uint8Array(wbMax * altura)
  let y = 0
  for (const p of pedacos) {
    if (p.tipo === 'avanco') {
      y += PONTOS_DO_AVANCO
      continue
    }
    for (let linha = 0; linha < p.h; linha++) {
      const origem = linha * p.wb
      bits.set(p.dados.subarray(origem, origem + p.wb), (y + linha) * wbMax)
    }
    y += p.h
  }
  return { largura: wbMax * 8, altura, bits }
}

const TABELA_CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(dados: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function bloco(tipo: string, dados: Uint8Array): Buffer {
  const cabecalho = Buffer.alloc(8)
  cabecalho.writeUInt32BE(dados.length, 0)
  cabecalho.write(tipo, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([cabecalho.subarray(4), Buffer.from(dados)])), 0)
  return Buffer.concat([cabecalho, Buffer.from(dados), crc])
}

export function pngDaPagina(p: PaginaRaster): Buffer {
  const wb = p.largura / 8
  const linhas = Buffer.alloc((wb + 1) * p.altura)
  for (let y = 0; y < p.altura; y++) {
    const destino = y * (wb + 1)
    linhas[destino] = 0
    for (let x = 0; x < wb; x++) linhas[destino + 1 + x] = ~p.bits[y * wb + x]! & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(p.largura, 0)
  ihdr.writeUInt32BE(p.altura, 4)
  ihdr[8] = 1
  ihdr[9] = 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(linhas)),
    bloco('IEND', new Uint8Array(0))
  ])
}

export type PaginaParaODriver = { html: string; papelMm: 58 | 80; alturaMm: number }

export function paginaParaODriver(p: PaginaRaster): PaginaParaODriver {
  const larguraMm = p.largura / PONTOS_POR_MM
  const imagemMm = p.altura / PONTOS_POR_MM
  const papelMm: 58 | 80 = p.largura > 384 ? 80 : 58
  const alturaMm = Math.ceil(imagemMm) + 6
  const png = pngDaPagina(p).toString('base64')
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    `@page{size:${papelMm}mm ${alturaMm}mm;margin:0}` +
    'html,body{margin:0;padding:0;background:#fff}' +
    `img{display:block;margin:0 auto;width:${larguraMm}mm;height:${imagemMm}mm;image-rendering:pixelated}` +
    `</style></head><body><img src="data:image/png;base64,${png}"></body></html>`
  return { html, papelMm, alturaMm }
}
