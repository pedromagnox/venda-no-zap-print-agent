import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSnapshot,
  ImpressoraSemFila,
  InstalarImpressoraResult,
  PaginaDoWindows,
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

  setPrinter: (printer: PrinterConfig, chave?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:setPrinter', printer, chave),

  setPreferences: (prefs: Preferences): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:setPreferences', prefs),

  testPrint: (chave?: string): Promise<{ ok: boolean; error?: string; code?: string; hint?: string }> =>
    ipcRenderer.invoke('agent:testPrint', chave),

  printTestReceipt: (
    mode: PrintModeSelection,
    chave?: string
  ): Promise<{ ok: boolean; error?: string; code?: string; hint?: string }> =>
    ipcRenderer.invoke('agent:printTestReceipt', mode, chave),

  /** v1.14.0: várias impressoras neste computador. */
  adicionarImpressora: (): Promise<{ ok: boolean; chave?: string; error?: string }> =>
    ipcRenderer.invoke('agent:adicionarImpressora'),

  removerImpressora: (chave: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agent:removerImpressora', chave),

  renomearImpressora: (chave: string, nome: string): Promise<{ ok: boolean; nome?: string; error?: string }> =>
    ipcRenderer.invoke('agent:renomearImpressora', chave, nome),

  listSpoolerPrinters: (): Promise<SpoolerPrinterInfo[]> =>
    ipcRenderer.invoke('agent:listSpoolerPrinters'),

  /** v1.12.0: Bluetooth pareada ou USB sem driver, ainda sem impressora no Windows. */
  listSemFila: (): Promise<ImpressoraSemFila[]> => ipcRenderer.invoke('agent:listSemFila'),

  /** Cria a impressora «Generic / Text Only» na porta (pode abrir a permissão do Windows). */
  instalarImpressora: (item: ImpressoraSemFila): Promise<InstalarImpressoraResult> =>
    ipcRenderer.invoke('agent:instalarImpressora', item),

  abrirConfiguracaoDoWindows: (pagina: PaginaDoWindows): Promise<void> =>
    ipcRenderer.invoke('agent:abrirConfiguracaoDoWindows', pagina)
}

contextBridge.exposeInMainWorld('printAgent', api)

export type PrintAgentApi = typeof api
