/** Pequenas contas usadas em vários serviços. */

export type NivelRisco = "low" | "medium" | "high" | "critical" | "sem_dados";

/** Mesma escala de gold.fn_nivel_risco e do front. */
export function nivelRisco(score: number | null | undefined): NivelRisco {
  if (score === null || score === undefined || Number.isNaN(score)) return "sem_dados";
  if (score < 35) return "low";
  if (score < 60) return "medium";
  if (score < 80) return "high";
  return "critical";
}

export function arred(valor: number | null | undefined, casas = 1): number | null {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return null;
  const f = 10 ** casas;
  return Math.round(valor * f) / f;
}

/** Variação percentual de `atual` sobre `anterior` (null quando não há base). */
export function variacaoPercentual(atual: number | null | undefined, anterior: number | null | undefined): number | null {
  if (atual === null || atual === undefined || anterior === null || anterior === undefined || anterior === 0) return null;
  return Math.round(((atual - anterior) / anterior) * 100);
}

export const formatarReais = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export const formatarNumero = (v: number | null | undefined, casas = 0) =>
  v === null || v === undefined ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: casas });
