// Fatiamento de cupom raster pra impressora com buffer pequeno.
//
// Origem (09/08/2026, loja Veganices): cupom raster de 95KB / 1972px saiu
// PELA METADE numa POS58 clone — só o final imprimiu. O cupom gerado no
// servidor estava íntegro (reconstruído byte a byte) e o spooler aceitou o
// job; o que falha é o firmware da impressora, que recebe mais rápido do que
// imprime e sobrescreve o próprio buffer circular.
//
// Mandar N jobs seguidos NÃO resolve sozinho: pro spooler "job concluído" =
// "bytes escritos na porta", então ele despeja o job seguinte na mesma vazão.
// O que resolve é a PAUSA entre as partes — tempo real de papel andando.
//
// Só é usado com a preferência "imprimindo pela metade" ligada (default OFF):
// é heurística contra hardware ruim e custa alguns segundos por cupom.

/** Um bloco `GS v 0` (raster bit image) localizado no stream. */
type RasterBlock = { start: number; end: number; height: number }

/** 203 dpi = 8 dots/mm — universal em térmica de cupom. */
const DOTS_PER_MM = 8
/** Velocidade conservadora de impressão. As baratas ficam abaixo dos 60mm/s
 *  nominais quando o raster é denso; subestimar aqui só torna a pausa maior. */
const MM_PER_SEC = 50
/** Altura alvo por parte (~8cm de papel). Abaixo disso a pausa vira overhead;
 *  acima, uma impressora com buffer pequeno volta a estourar. */
const MAX_PART_HEIGHT_PX = 640
/** Nunca menos que isto — o pedido do Pedro (09/08) e o piso que faz sentido
 *  pra um cupom curto que mesmo assim corta. */
const MIN_PARTS = 3
const MIN_PAUSE_MS = 400
const MAX_PAUSE_MS = 5_000

/**
 * Localiza os blocos `GS v 0` do stream. Parse sequencial: ao encontrar um
 * bloco, pula exatamente os `w*h` bytes de dados — assim um padrão que
 * pareça `GS v 0` DENTRO da imagem nunca é confundido com comando.
 *
 * Devolve null se o stream não fizer sentido (header truncado, tamanho maior
 * que o buffer). Nesse caso o caller imprime inteiro, sem fatiar: cortar no
 * lugar errado produziria lixo binário na impressora.
 */
function findRasterBlocks(bytes: Buffer): RasterBlock[] | null {
  const blocks: RasterBlock[] = []
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      // GS v 0 m xL xH yL yH + dados
      if (i + 8 > bytes.length) return null
      const widthBytes = bytes.readUInt16LE(i + 4) // xL + 256*xH
      const height = bytes.readUInt16LE(i + 6) // yL + 256*yH
      const end = i + 8 + widthBytes * height
      if (widthBytes === 0 || height === 0 || end > bytes.length) return null
      blocks.push({ start: i, end, height })
      i = end
    } else {
      i++
    }
  }
  return blocks
}

export type RasterChunk = { bytes: Buffer; heightPx: number; pauseAfterMs: number }

/**
 * Divide o stream em partes contíguas, cortando SÓ na fronteira entre blocos
 * raster. As fatias cobrem o buffer inteiro e mantêm a ordem, então o `ESC @`
 * inicial fica na primeira parte e o corte/avanço final na última — nada é
 * reinicializado no meio do cupom.
 *
 * Devolve null quando não vale a pena (ou não é seguro) fatiar: sem blocos,
 * bloco único, ou stream que não parseia.
 */
export function splitRasterForSlowPrinter(bytes: Buffer): RasterChunk[] | null {
  const blocks = findRasterBlocks(bytes)
  if (!blocks || blocks.length < 2) return null

  const totalHeight = blocks.reduce((sum, b) => sum + b.height, 0)
  const wanted = Math.max(MIN_PARTS, Math.ceil(totalHeight / MAX_PART_HEIGHT_PX))
  // Não dá pra ter mais partes que blocos — cada corte é entre dois blocos.
  const parts = Math.min(wanted, blocks.length)
  if (parts < 2) return null
  const targetHeight = totalHeight / parts

  // Agrupa blocos até cada grupo alcançar a altura alvo, sempre deixando
  // blocos suficientes pra fechar os grupos restantes.
  const groups: RasterBlock[][] = []
  let current: RasterBlock[] = []
  let currentHeight = 0
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]
    if (!block) continue
    current.push(block)
    currentHeight += block.height
    const groupsLeftAfterThis = parts - groups.length - 1
    const blocksLeft = blocks.length - b - 1
    const mustClose = blocksLeft === groupsLeftAfterThis && groupsLeftAfterThis > 0
    if ((currentHeight >= targetHeight && groups.length < parts - 1) || mustClose) {
      groups.push(current)
      current = []
      currentHeight = 0
    }
  }
  if (current.length > 0) groups.push(current)
  if (groups.length < 2) return null

  return groups.map((group, idx) => {
    // Primeira parte começa em 0 (leva o init); última vai até o fim do
    // buffer (leva o corte). As fatias são contíguas e não se sobrepõem.
    const first = group[0]
    const last = group[group.length - 1]
    const start = idx === 0 || !first ? 0 : first.start
    const end = idx === groups.length - 1 || !last ? bytes.length : last.end
    const heightPx = group.reduce((sum, b) => sum + b.height, 0)
    return {
      bytes: bytes.subarray(start, end),
      heightPx,
      pauseAfterMs: idx === groups.length - 1 ? 0 : pauseForHeight(heightPx)
    }
  })
}

/** Tempo aproximado que a impressora leva pra imprimir `heightPx` de papel. */
function pauseForHeight(heightPx: number): number {
  const ms = (heightPx / DOTS_PER_MM / MM_PER_SEC) * 1000
  return Math.round(Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, ms)))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Imprime `data` respeitando a preferência "imprimindo pela metade".
 *
 * Com a preferência desligada (default), ou quando o payload não é raster
 * fatiável, manda tudo num job só — comportamento idêntico ao de sempre.
 * Uma parte que falha propaga o erro: o item volta pra fila e o retry
 * reimprime o cupom do zero (pode sair papel repetido, e isso é melhor do
 * que cupom faltando pedaço).
 */
export async function printMaybeChunked(
  printer: { print: (data: Buffer | string, docname?: string) => Promise<void> },
  data: Buffer | string,
  docname: string,
  slowPrint: boolean,
  onChunked?: (parts: number, extraMs: number) => void
): Promise<void> {
  const chunks = slowPrint && Buffer.isBuffer(data) ? splitRasterForSlowPrinter(data) : null
  if (!chunks) {
    await printer.print(data, docname)
    return
  }
  onChunked?.(chunks.length, chunks.reduce((sum, c) => sum + c.pauseAfterMs, 0))
  let index = 0
  for (const chunk of chunks) {
    index++
    await printer.print(chunk.bytes, `${docname} (${index}/${chunks.length})`)
    // A pausa é o mecanismo — sem ela, o spooler despeja a parte seguinte na
    // mesma vazão e o buffer da impressora estoura igual.
    if (chunk.pauseAfterMs > 0) await sleep(chunk.pauseAfterMs)
  }
}
