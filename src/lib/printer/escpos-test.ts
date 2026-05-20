// Bytes ESC/POS de uma página de teste. Pura ASCII pra evitar dor de cabeça
// com code pages — bytes reais do backend já vêm com CP1252 aplicado.

const ESC = 0x1b
const GS = 0x1d

const CMDS = {
  init: Buffer.from([ESC, 0x40]),
  alignLeft: Buffer.from([ESC, 0x61, 0]),
  alignCenter: Buffer.from([ESC, 0x61, 1]),
  textNormal: Buffer.from([ESC, 0x21, 0x00]),
  textDoubleAll: Buffer.from([ESC, 0x21, 0x30]),
  boldOn: Buffer.from([ESC, 0x45, 1]),
  boldOff: Buffer.from([ESC, 0x45, 0]),
  feed: (n: number): Buffer => Buffer.from([ESC, 0x64, n]),
  cut: Buffer.from([GS, 0x56, 0x00])
}

const t = (s: string): Buffer => Buffer.from(s, 'ascii')

export function buildTestPage(): Buffer {
  const now = new Date()
  const stamp = now.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return Buffer.concat([
    CMDS.init,
    CMDS.alignCenter,
    CMDS.textDoubleAll,
    t('VENDA NO ZAP\n'),
    CMDS.textNormal,
    CMDS.boldOn,
    t('Print Agent\n'),
    CMDS.boldOff,
    CMDS.feed(1),
    CMDS.alignLeft,
    t('--------------------------------\n'),
    t('Teste de impressao\n'),
    t(`Data: ${stamp}\n`),
    t('--------------------------------\n'),
    CMDS.feed(1),
    CMDS.alignCenter,
    t('Se voce esta lendo isto,\n'),
    t('sua impressora esta conectada!\n'),
    CMDS.feed(4),
    CMDS.cut
  ])
}
