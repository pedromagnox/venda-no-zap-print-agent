import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImpressoraSemFila } from '@shared/types'

// v1.12.0: térmica que o Windows enxerga mas ainda não tem impressora criada
// (Bluetooth pareada ou USB sem driver). «Usar esta» cria a impressora
// «Generic / Text Only» na porta certa e a seleciona — o lojista não escolhe
// porta. Fica embaixo do select das impressoras do Windows.

const REFRESH_MS = 5_000

// Marcas com driver próprio: a Generic imprime pelo app, mas outro programa
// que imprime em modo gráfico (99Food, por exemplo) precisa do driver delas.
const MARCAS_COM_DRIVER: Record<string, string> = {
  '20D1': 'Elgin',
  '0B1B': 'Bematech',
  '04B8': 'Epson',
  '0DD4': 'Custom',
  '1504': 'Bixolon',
  '0519': 'Star',
  '154F': 'Diebold/Procomp',
  '0E8D': 'Tanca'
}

type Props = {
  /** Depois de criar: recarrega a lista do Windows e seleciona a nova. */
  onInstalled: (queueName: string) => void
  /** Avisa o pai se há algo na lista (pra trocar o texto de «nenhuma impressora»). */
  onCount?: (n: number) => void
}

export function ImpressorasSemFila({ onInstalled, onCount }: Props): JSX.Element | null {
  const [itens, setItens] = useState<ImpressoraSemFila[]>([])
  const [criando, setCriando] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const vivo = useRef(true)
  // Em ref: o pai passa função nova a cada render, e o intervalo não deve
  // reiniciar por isso.
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount

  const carregar = useCallback(async (): Promise<void> => {
    try {
      const lista = await window.printAgent.listSemFila()
      if (!vivo.current) return
      setItens(lista)
      onCountRef.current?.(lista.length)
    } catch {
      /* lista é ajuda, não bloqueia nada */
    }
  }, [])

  // Atualiza sozinho enquanto a tela está aberta: o lojista pareia no
  // Bluetooth do Windows (ou pluga o cabo) e a impressora aparece aqui.
  useEffect(() => {
    vivo.current = true
    void carregar()
    const t = setInterval(() => void carregar(), REFRESH_MS)
    return () => {
      vivo.current = false
      clearInterval(t)
    }
  }, [carregar])

  const usar = async (item: ImpressoraSemFila): Promise<void> => {
    setErro(null)
    setCriando(item.port)
    try {
      const r = await window.printAgent.instalarImpressora(item)
      if (r.ok) {
        onInstalled(r.queueName)
        await carregar()
      } else {
        setErro(
          'Não deu para criar a impressora automaticamente. Se o Windows pediu permissão, ' +
            'clique em Sim. Se não pediu, chame o suporte.'
        )
      }
    } finally {
      if (vivo.current) setCriando(null)
    }
  }

  if (itens.length === 0) return null

  return (
    <div className="sem-fila">
      <div className="sem-fila-titulo">Encontradas neste computador</div>
      {itens.map((item) => {
        const marca = item.vid ? MARCAS_COM_DRIVER[item.vid] : undefined
        return (
          <div key={item.port} className="sem-fila-item">
            <div className="sem-fila-texto">
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
              {marca && (
                <span className="sem-fila-aviso">
                  Se você também imprime por outro programa (iFood, 99Food), instale o driver da{' '}
                  {marca}.
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={criando !== null}
              onClick={() => void usar(item)}
            >
              {criando === item.port ? 'Criando…' : 'Usar esta'}
            </button>
          </div>
        )
      })}
      {criando && (
        <div className="field-hint">Se o Windows pedir permissão, clique em <strong>Sim</strong>.</div>
      )}
      {erro && (
        <div className="field-hint" style={{ color: 'var(--color-error)' }}>
          {erro}
        </div>
      )}
    </div>
  )
}
