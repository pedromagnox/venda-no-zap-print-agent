import type { PaperWidth } from '@shared/types'

/**
 * Normaliza qualquer representação de paperWidth que o backend possa enviar
 * (number literal `58`/`80`, ou string `"58"`/`"58mm"`/`"80mm"`) para o tipo
 * canônico `58 | 80` usado internamente.
 *
 * Default = 80mm (padrão de mercado pra impressoras térmicas).
 */
export function normalizePaperWidth(v: number | string | undefined | null): PaperWidth {
  if (v === 58 || v === '58mm' || v === '58') return 58
  return 80
}
