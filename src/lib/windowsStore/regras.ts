import type { InicioAutomatico } from '../../shared/types'

export const FAMILIA_DO_PACOTE = 'VendanoZap.VendanoZapImpresso_6h62scjbd05x8'
export const APP_DO_PACOTE = `${FAMILIA_DO_PACOTE}!VendaNoZapImpressao`
export const TAREFA_DE_INICIO = 'SlackStartup'
export const TAREFA_DE_REABRIR = 'Venda no Zap Impressao - reabrir depois de atualizar'
export const EXE_DO_APP = 'Venda no Zap Print Agent.exe'

const ESTADOS: Record<string, InicioAutomatico> = {
  Enabled: 'ligado',
  EnabledByPolicy: 'ligado_pela_politica',
  Disabled: 'desligado',
  DisabledByUser: 'desligado_pelo_usuario',
  DisabledByPolicy: 'desligado_pela_politica'
}

export function estadoDoInicio(saida: string): InicioAutomatico {
  const linhas = saida.trim().split(/\r?\n/)
  const ultima = (linhas[linhas.length - 1] ?? '').trim()
  return ESTADOS[ultima] ?? 'desconhecido'
}

export function inicioLigado(estado: InicioAutomatico): boolean {
  return estado === 'ligado' || estado === 'ligado_pela_politica'
}

export function inicioDesligado(estado: InicioAutomatico): boolean {
  return estado === 'desligado' || estado === 'desligado_pelo_usuario' || estado === 'desligado_pela_politica'
}

export type Atualizacoes = { quantas: number; emSilencio: boolean }

export function lerAtualizacoes(saida: string): Atualizacoes | null {
  const m = /^(\d+)\|(True|False)\s*$/m.exec(saida)
  return m ? { quantas: Number(m[1]), emSilencio: m[2] === 'True' } : null
}

export function resultadoDaStore(saida: string): string {
  const linhas = saida.trim().split(/\r?\n/)
  return (linhas[linhas.length - 1] ?? '').trim()
}

export function doAppAntigo(caminho: string | null | undefined): boolean {
  if (!caminho) return false
  if (/\\WindowsApps\\/i.test(caminho)) return false
  return caminho.toLowerCase().endsWith(EXE_DO_APP.toLowerCase())
}

export const QUIETO_MS = 10 * 60_000

export function podeAtualizarAgora(o: {
  agora: number
  ultimaImpressao: number | null
  ocupado: boolean
  pendentesLocais: number
}): boolean {
  if (o.ocupado || o.pendentesLocais > 0) return false
  return o.ultimaImpressao === null || o.agora - o.ultimaImpressao >= QUIETO_MS
}

export function ultimaImpressao(historico: { printedAt: string }[]): number | null {
  let maior: number | null = null
  for (const h of historico) {
    const t = Date.parse(h.printedAt)
    if (Number.isFinite(t) && (maior === null || t > maior)) maior = t
  }
  return maior
}

export type MarcaDeAtualizacao = { de: string; em: number }

export function lerMarca(texto: string | null): MarcaDeAtualizacao | null {
  if (!texto) return null
  try {
    const v = JSON.parse(texto) as Partial<MarcaDeAtualizacao>
    return typeof v.de === 'string' && typeof v.em === 'number' ? { de: v.de, em: v.em } : null
  } catch {
    return null
  }
}

export function voltouAgora(marca: MarcaDeAtualizacao | null, agora: number): boolean {
  return marca !== null && agora - marca.em >= 0 && agora - marca.em < 20 * 60_000
}
