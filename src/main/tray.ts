import { app, Menu, nativeImage, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus } from '@shared/types'

function iconPath(status: AgentStatus, size: 16 | 32): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons', `tray-${status}-${size}.png`)
  }
  return join(app.getAppPath(), 'build', 'icons', `tray-${status}-${size}.png`)
}

function loadTrayImage(status: AgentStatus): Electron.NativeImage {
  const p16 = iconPath(status, 16)
  if (!existsSync(p16)) {
    console.warn('[tray] ícone não encontrado:', p16, '— rode `npm run icons`')
    return nativeImage.createEmpty()
  }
  const img = nativeImage.createFromPath(p16)
  const p32 = iconPath(status, 32)
  if (existsSync(p32)) {
    img.addRepresentation({
      scaleFactor: 2,
      buffer: nativeImage.createFromPath(p32).toPNG()
    })
  }
  return img
}

export type TrayController = {
  setStatus: (status: AgentStatus) => void
  destroy: () => void
}

export type TrayOptions = {
  // Quando definido, adiciona item dev no menu pra semear pedido no mock.
  devSeedJob?: () => string
}

export function createTray(
  window: BrowserWindow,
  onQuit: () => void,
  options: TrayOptions = {}
): TrayController {
  const tray: Tray = new Tray(loadTrayImage('yellow'))
  let currentStatus: AgentStatus = 'yellow'

  const statusSublabel = (): string =>
    currentStatus === 'green' ? 'Conectado' : currentStatus === 'yellow' ? 'Atenção' : 'Erro'

  const rebuildMenu = (): void => {
    const items: MenuItemConstructorOptions[] = [
      { label: 'Abrir Venda no Zap Print Agent', click: () => window.show() },
      { type: 'separator' },
      { label: `Status: ${statusSublabel()}`, enabled: false }
    ]
    if (options.devSeedJob) {
      items.push(
        { type: 'separator' },
        {
          label: 'Adicionar pedido de teste (mock)',
          click: () => {
            const id = options.devSeedJob!()
            console.log('[tray] mock seeded:', id)
          }
        }
      )
    }
    items.push({ type: 'separator' }, { label: 'Sair', click: onQuit })
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  tray.setToolTip('Venda no Zap Print Agent')
  rebuildMenu()
  tray.on('click', () => (window.isVisible() ? window.hide() : window.show()))

  return {
    setStatus(status: AgentStatus) {
      if (status === currentStatus) return
      currentStatus = status
      tray.setImage(loadTrayImage(status))
      rebuildMenu()
    },
    destroy() {
      tray.destroy()
    }
  }
}
