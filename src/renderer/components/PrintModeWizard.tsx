import { useEffect, useRef, useState } from 'react'
import { Logo } from './Logo'
import type { PrintModeSelection } from '@shared/types'

// Teste guiado de modo de impressão (substitui a auto-detecção frágil).
// O lojista imprime um cupom-amostra e responde como saiu; o app escala o modo
// sozinho até acertar:
//   Texto (escpos) → acento certo?  Sim: pronto.  Não: ↓
//   Imagem (raster) → nítido/completo?  Sim: pronto.  Não: ↓
//   Simples (ascii) → legível?  Sim: pronto.  Não: beco (suporte / Texto).
//
// Regras (não inverter):
//  (a) "não saiu nada" = problema de CONEXÃO, não de modo → repete o MESMO modo.
//  (b) raster sempre mostra acento certo (é imagem) → a pergunta de acento
//      termina no Texto; o Simples é o resgate pra quando a IMAGEM não sai.

type TestResult = { ok: boolean; error?: string; code?: string; hint?: string }

type Props = {
  onPrintTest: (mode: PrintModeSelection) => Promise<TestResult>
  onSelectMode: (mode: PrintModeSelection) => Promise<void>
  onDone: () => void
  onSupport: () => void
  /** Voltar pra troca de impressora (escape quando nada imprime). */
  onChangePrinter?: () => void
}

type View =
  | { kind: 'printing'; mode: PrintModeSelection }
  | { kind: 'ask-printed' } // Texto: saiu o cupom?
  | { kind: 'ask-accent' } // Texto: acentos certos?
  | { kind: 'ask-raster' } // Imagem: nítido e completo?
  | { kind: 'ask-ascii' } // Simples: legível?
  | { kind: 'noprint'; mode: PrintModeSelection; hint?: string }
  | { kind: 'deadend' }
  | { kind: 'saving' }

const MODE_LABEL: Record<PrintModeSelection, string> = {
  escpos: 'Texto',
  raster: 'Imagem',
  ascii: 'Simples'
}

export function PrintModeWizard({
  onPrintTest,
  onSelectMode,
  onDone,
  onSupport,
  onChangePrinter
}: Props): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'printing', mode: 'escpos' })
  const started = useRef(false)

  const printAndAsk = async (mode: PrintModeSelection): Promise<void> => {
    setView({ kind: 'printing', mode })
    const r = await onPrintTest(mode)
    if (!r.ok) {
      // Falha ao enviar = não saiu nada = conexão. Repete o MESMO modo.
      setView({ kind: 'noprint', mode, hint: r.hint })
      return
    }
    setView(
      mode === 'escpos'
        ? { kind: 'ask-printed' }
        : mode === 'raster'
          ? { kind: 'ask-raster' }
          : { kind: 'ask-ascii' }
    )
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void printAndAsk('escpos')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (mode: PrintModeSelection): Promise<void> => {
    setView({ kind: 'saving' })
    try {
      await onSelectMode(mode)
    } finally {
      onDone()
    }
  }

  return (
    <div className="printer-onboarding">
      <div className="printer-onboarding-hero">
        <Logo size={48} />
        <h1>Teste de impressão</h1>
        <p>Vamos achar o melhor modo pra sua impressora — é rápido.</p>
      </div>

      <div className="printer-onboarding-card">{renderBody()}</div>
    </div>
  )

  function renderBody(): JSX.Element {
    switch (view.kind) {
      case 'printing':
        return (
          <div className="field">
            <p>
              Imprimindo um cupom de teste em modo <strong>{MODE_LABEL[view.mode]}</strong>…
            </p>
            <p className="field-hint">Aguarde o papel sair da impressora.</p>
          </div>
        )

      case 'ask-printed':
        return (
          <Question
            title="Saiu um cupom de teste da impressora?"
            hint="Estamos verificando primeiro se a impressora está respondendo."
            yes={{ label: 'Sim, saiu', onClick: () => setView({ kind: 'ask-accent' }) }}
            no={{
              label: 'Não saiu nada',
              onClick: () => setView({ kind: 'noprint', mode: 'escpos' })
            }}
          />
        )

      case 'ask-accent':
        return (
          <Question
            title="Os acentos saíram CERTOS?"
            hint="Confira no cupom: ç, ã, é, ô. Se virou símbolo estranho ou ideograma, marque “Não”."
            yes={{ label: 'Sim, acentos certos', onClick: () => void save('escpos') }}
            no={{ label: 'Não, saíram errados', onClick: () => void printAndAsk('raster') }}
          />
        )

      case 'ask-raster':
        return (
          <Question
            title="O cupom saiu nítido e completo?"
            hint="Agora imprimimos como imagem — o acento sempre sai certo. Confira se não saiu cortado, borrado ou em branco."
            yes={{ label: 'Sim, saiu certinho', onClick: () => void save('raster') }}
            no={{ label: 'Não, saiu ruim', onClick: () => void printAndAsk('ascii') }}
          />
        )

      case 'ask-ascii':
        return (
          <Question
            title="Deu pra ler o cupom?"
            hint="Este é o modo simples — sem acento, mas legível em qualquer impressora."
            yes={{ label: 'Sim, dá pra ler', onClick: () => void save('ascii') }}
            no={{ label: 'Não, ilegível', onClick: () => setView({ kind: 'deadend' }) }}
          />
        )

      case 'noprint':
        return (
          <div className="field">
            <p>
              <strong>Não saiu nada?</strong> Quase sempre é conexão, não o modo. Confira:
            </p>
            <ul style={{ margin: '4px 0 10px 18px', padding: 0, lineHeight: 1.5 }}>
              <li>Impressora ligada e com papel</li>
              <li>Cabo USB conectado (ou impressora na mesma rede)</li>
              <li>Tampa fechada</li>
            </ul>
            {view.hint && <div className="field-hint">{view.hint}</div>}
            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={() => void printAndAsk(view.mode)}
            >
              Imprimir de novo
            </button>
            {onChangePrinter && (
              <button type="button" className="btn btn-block" onClick={onChangePrinter}>
                Trocar de impressora
              </button>
            )}
            <button type="button" className="btn btn-block" onClick={onSupport}>
              Falar com o suporte
            </button>
          </div>
        )

      case 'deadend':
        return (
          <div className="field">
            <p>
              <strong>Nenhum modo saiu legível.</strong> Pode ser a impressora ou o papel. O
              suporte ajuda a resolver.
            </p>
            <button type="button" className="btn btn-primary btn-block" onClick={onSupport}>
              Falar com o suporte
            </button>
            <button type="button" className="btn btn-block" onClick={() => void save('escpos')}>
              Concluir mesmo assim
            </button>
          </div>
        )

      case 'saving':
        return (
          <div className="field">
            <p>Salvando o modo de impressão…</p>
          </div>
        )
    }
  }
}

function Question({
  title,
  hint,
  yes,
  no
}: {
  title: string
  hint?: string
  yes: { label: string; onClick: () => void }
  no: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="field">
      <p style={{ fontWeight: 600 }}>{title}</p>
      {hint && <div className="field-hint" style={{ marginBottom: 10 }}>{hint}</div>}
      <button type="button" className="btn btn-primary btn-block" onClick={yes.onClick}>
        {yes.label}
      </button>
      <button type="button" className="btn btn-block" onClick={no.onClick}>
        {no.label}
      </button>
    </div>
  )
}
