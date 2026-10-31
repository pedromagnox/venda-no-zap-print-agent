import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSnapshot,
  ImpressoraSemFila,
  InstalarImpressoraResult,
  PrinterConfig,
  Preferences,
  PrintModeSelection,
  SpoolerPrinterInfo
} from '@shared/types'

export type ConnectResult =
  | { ok: true; storeName: string }
  | { ok: false; error: string }

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  readClipboard: (): Promise<string> => ipcRenderer.invoke('app:readClipboard'),

  getSnapshot: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:getSnapshot'),

  onSnapshot: (callback: (snap: AgentSnapshot) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, snap: AgentSnapshot): void => callback(snap)
    ipcRenderer.on('agent:snapshot', listener)
    return () => ipcRenderer.removeListener('agent:snapshot', listener)
  },

  connect: (refreshToken: string): Promise<ConnectResult> =>
    ipcRenderer.invoke('agent:connect', refreshToken),

  disconnect: (): Promise<void> => ipcRenderer.invoke('agent:disconnect'),

  /** v1.11.0: desconecta UMA loja da lista (o X de cada linha). */
  disconnectStore: (storeId: string): Promise<void> =>
    ipcRenderer.invoke('agent:disconnectStore', storeId),

  setPrinter: (printer: PrinterConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:setPrinter', printer),

  setPreferences: (prefs: Preferences): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:setPreferences', prefs),

  testPrint: (): Promise<{ ok: boolean; error?: string; code?: string; hint?: string }> =>
    ipcRenderer.invoke('agent:testPrint'),

  printTestReceipt: (
    mode: PrintModeSelection
  ): Promise<{ ok: boolean; error?: string; code?: string; hint?: string }> =>
    ipcRenderer.invoke('agent:printTestReceipt', mode),

  listSpoolerPrinters: (): Promise<SpoolerPrinterInfo[]> =>
    ipcRenderer.invoke('agent:listSpoolerPrinters'),

  /** v1.12.0: Bluetooth pareada ou USB sem driver, ainda sem impressora no Windows. */
  listSemFila: (): Promise<ImpressoraSemFila[]> => ipcRenderer.invoke('agent:listSemFila'),

  /** Cria a impressora «Generic / Text Only» na porta (pode abrir a permissão do Windows). */
  instalarImpressora: (item: ImpressoraSemFila): Promise<InstalarImpressoraResult> =>
    ipcRenderer.invoke('agent:instalarImpressora', item)
}

contextBridge.exposeInMainWorld('printAgent', api)

export type PrintAgentApi = typeof api
