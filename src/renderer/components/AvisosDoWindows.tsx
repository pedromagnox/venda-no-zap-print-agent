import type { EstadoDaStore } from '@shared/types'

type AvisosDoWindowsProps = {
  estado: EstadoDaStore | null
  onLigarInicio: () => void
  onAbrirAplicativos: () => void
}

export function AvisosDoWindows({ estado, onLigarInicio, onAbrirAplicativos }: AvisosDoWindowsProps): JSX.Element | null {
  if (!estado) return null
  const inicioDesligado =
    estado.inicioAutomatico === 'desligado' ||
    estado.inicioAutomatico === 'desligado_pelo_usuario' ||
    estado.inicioAutomatico === 'desligado_pela_politica'
  if (!inicioDesligado && !estado.antigoInstalado) return null
  return (
    <div className="avisos-windows">
      {inicioDesligado && (
        <div className="aviso-windows">
          <span>
            O aplicativo não vai abrir sozinho quando o computador ligar, e os pedidos ficam esperando até alguém abrir.
          </span>
          <button type="button" className="btn btn-primary" onClick={onLigarInicio}>
            Ligar
          </button>
        </div>
      )}
      {estado.antigoInstalado && (
        <div className="aviso-windows">
          <span>
            O aplicativo antigo (Venda no Zap Print Agent) ainda está instalado. Desinstale para ele não abrir junto com o
            Windows. As lojas conectadas e a impressora continuam salvas.
          </span>
          <button type="button" className="btn" onClick={onAbrirAplicativos}>
            Abrir aplicativos instalados
          </button>
        </div>
      )}
    </div>
  )
}
