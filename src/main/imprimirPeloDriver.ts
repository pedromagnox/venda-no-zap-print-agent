import { BrowserWindow } from 'electron'
import { paginaParaODriver, paginasDoRaster, type PaginaParaODriver } from '@lib/printer/rasterParaImagem'
import { PrinterError } from '@lib/printer'

const PRAZO_MS = 60_000

export async function imprimirPeloDriver(bytes: Uint8Array, fila: string): Promise<void> {
  const paginas = paginasDoRaster(bytes)
  if (paginas.length === 0) {
    throw new PrinterError('INVALID_CONFIG', 'o cupom veio sem imagem para imprimir pelo driver do Windows')
  }
  for (const pagina of paginas) await imprimirPagina(paginaParaODriver(pagina), fila)
}

async function imprimirPagina(pagina: PaginaParaODriver, fila: string): Promise<void> {
  const janela = new BrowserWindow({
    show: false,
    width: 420,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await janela.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pagina.html)}`)
    await janela.webContents.executeJavaScript(
      'new Promise((r) => { const i = document.images[0]; if (!i || i.complete) r(true); else { i.onload = () => r(true); i.onerror = () => r(false) } })'
    )
    await new Promise<void>((resolve, reject) => {
      const prazo = setTimeout(
        () => reject(new PrinterError('TIMEOUT', `o driver da impressora não respondeu em ${PRAZO_MS / 1000} s`)),
        PRAZO_MS
      )
      janela.webContents.print(
        {
          silent: true,
          deviceName: fila,
          printBackground: true,
          color: false,
          copies: 1,
          margins: { marginType: 'none' },
          pageSize: { width: pagina.papelMm * 1000, height: pagina.alturaMm * 1000 }
        },
        (ok, motivo) => {
          clearTimeout(prazo)
          if (ok) resolve()
          else reject(new PrinterError('IO_ERROR', `o driver da impressora recusou o cupom (${motivo || 'sem motivo'})`))
        }
      )
    })
  } finally {
    if (!janela.isDestroyed()) janela.destroy()
  }
}
