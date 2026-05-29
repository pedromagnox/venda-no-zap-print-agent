// Formatação única do timestamp dos logs: `DD/MM HH:MM:SS`.
//
// A data é obrigatória: a retenção dos logs é de 48h (ver logsStore.ts), então
// um export de suporte abrange até 3 dias. Sem a data, os horários parecem
// "saltar" (19h → 22h → 18h) quando dias diferentes se intercalam, já que a
// ordenação é por timestamp completo (time_ms) mas o rótulo só mostrava a hora.
//
// Padding manual em vez de toLocaleString(): determinístico e independente da
// versão do ICU embarcado no Electron (evita vírgula/ordem variável entre
// builds). Horário local, igual ao comportamento anterior.
export function formatLogTime(ms: number = Date.now()): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
