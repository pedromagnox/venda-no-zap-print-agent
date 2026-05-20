// Logo do Venda no Zap. SVG ~3 KB importado como asset URL pelo Vite —
// renderiza nativamente no DOM, escala perfeitamente em qualquer tamanho,
// custo zero de runtime JS comparado a renderizar SVG inline em React.

import logoUrl from '@renderer/assets/logo.svg'

type LogoProps = {
  size?: number
}

export function Logo({ size = 32 }: LogoProps): JSX.Element {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt="Venda no Zap"
      draggable={false}
      style={{ display: 'block', borderRadius: size >= 24 ? 8 : 4 }}
    />
  )
}
