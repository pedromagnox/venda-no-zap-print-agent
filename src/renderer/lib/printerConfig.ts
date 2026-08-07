import type { PrinterConfig } from '@shared/types'

// v1.10.0: detecta erros comuns no input de impressora de rede ANTES do
// connect. Origem: caso jun/2026 onde um lojista digitou "174919869" (IP
// sem pontos), o Node tentou resolver como hostname e logou DNS_FAIL com
// uma string numérica incompreensível.
//
// v1.10.7: extraída pra cá — antes vivia só na PrinterSection e o wizard de
// onboarding (o caminho principal desde v1.10.5) aceitava qualquer string
// não-vazia. Caso 07/08/2026: "2292023110" salvo pelo wizard tem 6 leituras
// válidas como IP, então NÃO tentamos converter — só bloqueamos e avisamos.
export function describeHostIssue(rawHost: string | undefined | null): string | null {
  const host = (rawHost ?? '').trim()
  if (!host) return null // vazio é OK — usuário ainda não digitou
  // String com >=8 dígitos sem ponto/dois-pontos/letra é IP sem pontos:
  // o caso clássico do "digitou tudo grudado".
  if (/^\d{8,}$/.test(host)) {
    return 'Parece um IP sem os pontos. Use o formato 192.168.0.100.'
  }
  // Tenta IPv4 estrito (cada octeto 0-255)
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const octs = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((s) => Number(s))
    if (octs.some((n) => n < 0 || n > 255)) {
      return 'IP inválido — cada parte deve estar entre 0 e 255.'
    }
    return null
  }
  // Hostname/mDNS: letras, dígitos, hífen, ponto. Tolerante o suficiente
  // pra aceitar "impressora.local", "pos-58.local", "minhaloja-printer".
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
    return null
  }
  return 'Formato inválido. Use um IP (192.168.0.100) ou nome de host (impressora.local).'
}

// "Configurada" = tem alvo selecionado (spooler name ou host de rede) E, no
// caso de rede, o host passa na validação acima — host inválido salvo faz o
// wizard reabrir no boot, que é como o lojista descobre e corrige. Largura
// não conta como pendência — sempre tem default 80mm. Fonte única usada pelo
// gate de onboarding (App), pelo bloqueio do botão Continuar
// (PrinterOnboardingScreen) e pela PrinterSection.
export function isPrinterConfigured(p: PrinterConfig): boolean {
  if (p.type === 'windows_spooler') return !!(p.spoolerName ?? '').trim()
  if (p.type === 'network') return !!(p.host ?? '').trim() && describeHostIssue(p.host) === null
  return false
}
