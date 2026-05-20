// Gera ícones do tray (16x16 e 32x32) para os 3 estados: green, yellow, red.
//
// Lê `build/icon.png` (logo oficial), faz downsample via box-average pra
// resolução do tray, e compõe um dot colorido no canto inferior direito
// indicando o status do agente. Pura JS via pngjs — sem dependência nativa.
//
// Roda com `npm run icons`. Se o `build/icon.png` mudar, basta rerodar.

import { PNG } from 'pngjs'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'build', 'icons')
const SOURCE = resolve(__dirname, '..', 'build', 'icon.png')

if (!existsSync(SOURCE)) {
  console.error(`[tray] não achei ${SOURCE} — rode \`npm run icons\` depois de gerar/colocar o logo lá.`)
  process.exit(1)
}

const STATUS_COLORS = {
  green: { r: 0x43, g: 0xa0, b: 0x47 }, // #43A047
  yellow: { r: 0xff, g: 0xb3, b: 0x00 }, // #FFB300
  red: { r: 0xef, g: 0x44, b: 0x44 } // #EF4444
}
const WHITE = { r: 0xff, g: 0xff, b: 0xff }

const sourcePng = PNG.sync.read(readFileSync(SOURCE))

/**
 * Box-average downsample. Cada pixel de saída é a média dos pixels da
 * janela correspondente no source. Bom o suficiente pra ícones 16/32 px.
 * @param {PNG} src
 * @param {number} dstSize
 * @returns {PNG}
 */
function downsample(src, dstSize) {
  const dst = new PNG({ width: dstSize, height: dstSize })
  dst.data.fill(0)
  const sx = src.width / dstSize
  const sy = src.height / dstSize
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * 4
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          a += src.data[i + 3]
          n++
        }
      }
      const di = (y * dstSize + x) * 4
      dst.data[di] = Math.round(r / n)
      dst.data[di + 1] = Math.round(g / n)
      dst.data[di + 2] = Math.round(b / n)
      dst.data[di + 3] = Math.round(a / n)
    }
  }
  return dst
}

/** @param {PNG} png @param {number} cx @param {number} cy @param {number} r @param {{r:number,g:number,b:number}} color */
function fillCircle(png, cx, cy, r, color) {
  const minX = Math.max(0, Math.floor(cx - r - 1))
  const maxX = Math.min(png.width - 1, Math.ceil(cx + r + 1))
  const minY = Math.max(0, Math.floor(cy - r - 1))
  const maxY = Math.min(png.height - 1, Math.ceil(cy + r + 1))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      const edge = r - d
      if (edge <= -1) continue
      const srcA = Math.max(0, Math.min(1, edge + 0.5))
      const i = (y * png.width + x) * 4
      const dstA = png.data[i + 3] / 255
      const outA = srcA + dstA * (1 - srcA)
      if (outA <= 0) continue
      png.data[i] = Math.round((color.r * srcA + png.data[i] * dstA * (1 - srcA)) / outA)
      png.data[i + 1] = Math.round((color.g * srcA + png.data[i + 1] * dstA * (1 - srcA)) / outA)
      png.data[i + 2] = Math.round((color.b * srcA + png.data[i + 2] * dstA * (1 - srcA)) / outA)
      png.data[i + 3] = Math.round(outA * 255)
    }
  }
}

/**
 * @param {number} size 16 ou 32
 * @param {{r:number,g:number,b:number}} statusColor
 */
function renderTray(size, statusColor) {
  const png = downsample(sourcePng, size)
  // Status dot no canto inferior direito. Em 16px o ponto fica pequeno mas
  // ainda visível; em 32 (HiDPI) fica nítido.
  const dotR = Math.max(2, Math.round(size * 0.28))
  const dotCx = size - dotR - 1
  const dotCy = size - dotR - 1
  // Borda branca pra destacar do fundo laranja do logo.
  fillCircle(png, dotCx, dotCy, dotR + Math.max(1, Math.round(size * 0.07)), WHITE)
  fillCircle(png, dotCx, dotCy, dotR, statusColor)
  return PNG.sync.write(png)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, color] of Object.entries(STATUS_COLORS)) {
  for (const size of [16, 32]) {
    const buf = renderTray(size, color)
    const file = resolve(OUT_DIR, `tray-${name}-${size}.png`)
    writeFileSync(file, buf)
    console.log(`wrote ${file} (${buf.length} bytes, ${size}x${size})`)
  }
}
