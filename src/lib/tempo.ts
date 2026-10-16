/**
 * Datas no fuso de Brasília.
 *
 * Os dias das views Gold são dias de Brasília; "hoje" e os períodos dos
 * filtros precisam ser calculados no mesmo fuso, ou um filtro de "hoje" feito
 * às 22h veria o dia seguinte (UTC).
 */

export const FUSO = "America/Sao_Paulo";

const fmtDia = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

/** 'YYYY-MM-DD' do instante em Brasília. */
export function diaLocal(instante: Date = new Date()): string {
  return fmtDia.format(instante);
}

export function somarDias(dia: string, dias: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;
}

export function listaDias(de: string, ate: string): string[] {
  const n = diasEntre(de, ate);
  return Array.from({ length: Math.max(0, n) }, (_, i) => somarDias(de, i));
}

/** Partes da data/hora local (Brasília) de um instante. */
export function partesLocais(instante: Date) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instante);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  const semana = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    ano: Number(get("year")),
    mes: Number(get("month")),
    dia: Number(get("day")),
    hora: Number(get("hour")),
    minuto: Number(get("minute")),
    diaSemana: semana,
  };
}

/**
 * Converte uma data e hora de Brasília em instante UTC. Brasília não tem
 * horário de verão desde 2019, mas o cálculo usa o deslocamento real do fuso
 * para não depender disso.
 */
export function instanteLocal(dia: string, horario: string): Date {
  const [h, m] = horario.split(":").map(Number);
  const palpite = new Date(`${dia}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const p = partesLocais(palpite);
  const comoLocal = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
  const deslocamento = comoLocal - palpite.getTime();
  return new Date(palpite.getTime() - deslocamento);
}

export const formatarDiaBr = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
