/**
 * Filtros comuns da dashboard: período, região e tipo de veículo.
 *
 * Vêm na query string e viram fragmentos SQL parametrizados (postgres.js),
 * nunca texto concatenado.
 */

import { z } from "zod";
import type { Sql } from "./db";
import { invalido } from "./http";
import { diaLocal, diasEntre, somarDias } from "./tempo";

export const MACRO_REGIOES = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"] as const;
export const TIPOS_VEICULO = ["caminhao", "onibus", "van", "carro_app"] as const;

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");

const schema = z.object({
  periodo: z.enum(["hoje", "7d", "30d", "90d", "ano"]).optional(),
  de: dia.optional(),
  ate: dia.optional(),
  regiao: z.string().max(20).optional(),
  tipo_veiculo: z.enum(TIPOS_VEICULO).optional(),
});

export interface Periodo {
  de: string;
  ate: string;
  dias: number;
  /** Mesmo tamanho, imediatamente antes: base das comparações "vs período anterior". */
  anteriorDe: string;
  anteriorAte: string;
}

export interface Filtros {
  periodo: Periodo;
  regiao?: { tipo: "macro" | "uf"; valor: string };
  tipoVeiculo?: (typeof TIPOS_VEICULO)[number];
}

export function periodoDe(p: { periodo?: string; de?: string; ate?: string }, padrao = "30d"): Periodo {
  const hoje = diaLocal();
  let de: string;
  let ate: string;

  if (p.de || p.ate) {
    de = p.de ?? p.ate!;
    ate = p.ate ?? hoje;
  } else {
    ate = hoje;
    switch (p.periodo ?? padrao) {
      case "hoje": de = hoje; break;
      case "7d": de = somarDias(hoje, -6); break;
      case "90d": de = somarDias(hoje, -89); break;
      case "ano": de = `${hoje.slice(0, 4)}-01-01`; break;
      default: de = somarDias(hoje, -29);
    }
  }

  if (de > ate) throw invalido("A data inicial é posterior à final");
  const dias = diasEntre(de, ate);
  if (dias > 400) throw invalido("Período máximo de 400 dias");
  return { de, ate, dias, anteriorDe: somarDias(de, -dias), anteriorAte: somarDias(de, -1) };
}

export function lerFiltros(query: Record<string, string | undefined>, periodoPadrao = "30d"): Filtros {
  const q = schema.parse(query);
  const filtros: Filtros = { periodo: periodoDe(q, periodoPadrao) };

  if (q.regiao && !/^todas?/i.test(q.regiao)) {
    const macro = MACRO_REGIOES.find((m) => m.toLowerCase() === q.regiao!.toLowerCase());
    if (macro) filtros.regiao = { tipo: "macro", valor: macro };
    else if (/^[A-Za-z]{2}$/.test(q.regiao)) filtros.regiao = { tipo: "uf", valor: q.regiao.toUpperCase() };
    else throw invalido(`Região desconhecida: ${q.regiao}`);
  }
  if (q.tipo_veiculo) filtros.tipoVeiculo = q.tipo_veiculo;
  return filtros;
}

/**
 * Condições de região e tipo de veículo para as views que têm as colunas
 * macro_regiao, regiao_uf e tipo_veiculo (mv_kpis_diarios, mv_alertas_agregados,
 * mv_fadiga_por_tempo_direcao, vw_frota_agora, mv_ranking_motoristas).
 */
export function condicoesDimensao(sql: Sql, f: Filtros, alias?: string) {
  // Com JOIN entre duas dessas views a coluna fica ambígua: passe o alias.
  const col = (nome: string) => (alias ? sql`${sql(alias)}.${sql(nome)}` : sql(nome));
  const regiao = !f.regiao
    ? sql``
    : f.regiao.tipo === "macro"
      ? sql`AND ${col("macro_regiao")} = ${f.regiao.valor}`
      : sql`AND ${col("regiao_uf")} = ${f.regiao.valor}`;
  const veiculo = f.tipoVeiculo ? sql`AND ${col("tipo_veiculo")} = ${f.tipoVeiculo}` : sql``;
  return sql`${regiao} ${veiculo}`;
}

export const ROTULO_TIPO_VEICULO: Record<string, string> = {
  caminhao: "Caminhão",
  onibus: "Ônibus",
  van: "Van",
  carro_app: "Carro App",
  nd: "Não informado",
};
