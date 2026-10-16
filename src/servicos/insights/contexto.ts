/**
 * Monta o contexto dos insights a partir das views Gold (roda na VPC).
 */

import { randomUUID } from "node:crypto";
import { usuarioSistema } from "../../lib/auth";
import { db } from "../../lib/db";
import { lerFiltros } from "../../lib/filtros";
import { arred, variacaoPercentual } from "../../lib/numeros";
import { diaLocal } from "../../lib/tempo";
import { ROTULO_TIPO_VEICULO } from "../../lib/filtros";
import * as dashboard from "../dashboard";
import * as roi from "../roi";
import type { ContextoInsights } from "./tipos";

/** Período dos insights: o mesmo filtro da dashboard (periodo ou de/ate). */
export interface ConsultaPeriodo {
  periodo?: string;
  de?: string;
  ate?: string;
}

/** Período padrão dos insights: o padrão da dashboard. */
export const PERIODO_PADRAO = "30d";

export function filtrosDoPeriodo(consulta: ConsultaPeriodo = {}) {
  return lerFiltros({ periodo: consulta.periodo, de: consulta.de, ate: consulta.ate }, PERIODO_PADRAO);
}

/** Chave canônica do período (datas), a mesma para "30d" e para as datas equivalentes. */
export function chavePeriodo(p: { de: string; ate: string }) {
  return `${p.de}..${p.ate}`;
}

export function rotuloPeriodo(p: { de: string; ate: string; dias: number }) {
  const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  if (p.ate === diaLocal()) return p.dias === 1 ? "hoje" : `nos últimos ${p.dias} dias`;
  return p.de === p.ate ? `em ${br(p.de)}` : `de ${br(p.de)} a ${br(p.ate)}`;
}

export async function montarContexto(
  empresaId: string,
  execucaoId: string = randomUUID(),
  consulta: ConsultaPeriodo = {},
): Promise<ContextoInsights> {
  const sql = db();
  const u = usuarioSistema(empresaId);
  const f = filtrosDoPeriodo(consulta);

  const [kpis, tendencia, rotas, ranking, emRisco, porTipo, porRegiao, tipos, abertos, prf, calc, acidentes] = await Promise.all([
    dashboard.kpis(u, f),
    dashboard.tendenciaTurno(u, f),
    dashboard.rotas(u, f),
    sql`
      SELECT r.codigo, r.score_fadiga_medio, r.alertas_30d, r.alertas_graves_30d, r.horas_dirigidas_30d, r.nivel_risco,
             a.score_atual, a.horas_turno, a.ultima_leitura_em >= now() - interval '30 minutes' AS ativo
        FROM gold.mv_ranking_motoristas r
        LEFT JOIN gold.vw_frota_agora a ON a.motorista_id = r.motorista_id
       WHERE r.empresa_id = ${empresaId} AND r.score_fadiga_medio IS NOT NULL
       ORDER BY r.score_fadiga_medio DESC
       LIMIT 8
    `,
    sql`
      SELECT codigo, score_atual, horas_turno
        FROM gold.vw_frota_agora
       WHERE empresa_id = ${empresaId} AND ultima_leitura_em >= now() - interval '30 minutes' AND score_atual >= 70
       ORDER BY score_atual DESC
    `,
    sql`
      SELECT tipo_veiculo, ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS fadiga, SUM(total_alertas)::int AS alertas
        FROM gold.mv_kpis_diarios
       WHERE empresa_id = ${empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
       GROUP BY tipo_veiculo ORDER BY fadiga DESC NULLS LAST
    `,
    sql`
      SELECT macro_regiao, ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS fadiga, SUM(total_alertas)::int AS alertas
        FROM gold.mv_kpis_diarios
       WHERE empresa_id = ${empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
       GROUP BY macro_regiao ORDER BY fadiga DESC NULLS LAST
    `,
    sql`
      SELECT tipo, SUM(total)::int AS total
        FROM gold.mv_alertas_agregados
       WHERE empresa_id = ${empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
       GROUP BY tipo ORDER BY 2 DESC
    `,
    sql`
      SELECT COUNT(*)::int AS total
        FROM silver.alertas a JOIN silver.motoristas m ON m.id = a.motorista_id
       WHERE m.empresa_id = ${empresaId} AND a.status = 'aberto' AND a.gravidade IN ('alta', 'critica')
         AND (a.disparado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
    `,
    dashboard.prfFaixaHoraria(f, {}),
    roi.calcular(empresaId),
    sql`
      SELECT i.ocorrido_em, i.relacionado_sonolencia, i.descricao, m.codigo,
             to_char(i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS hora_local,
             (i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date >= ${f.periodo.de}::date AS no_periodo
        FROM silver.incidentes i LEFT JOIN silver.motoristas m ON m.id = i.motorista_id
       WHERE i.empresa_id = ${empresaId} AND i.origem = 'interno'
         AND (i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.anteriorDe} AND ${f.periodo.ate}
       ORDER BY i.ocorrido_em DESC
    `,
  ]);
  const noPeriodo = acidentes.filter((a) => a.no_periodo);
  const anteriores = acidentes.filter((a) => !a.no_periodo);
  const sonoFrota = noPeriodo.filter((a) => a.relacionado_sonolencia);

  const sonoPesados = prf.carregada ? prf.faixas.reduce((a, x) => a + (x.acidentesSono as number), 0) : 0;
  const madrugadaPrf = prf.carregada ? prf.faixas.find((x) => x.faixa === "madrugada")?.percentualSono ?? null : null;

  return {
    versao: 1,
    execucaoId,
    empresaId,
    geradoEm: new Date().toISOString(),
    periodo: {
      de: f.periodo.de,
      ate: f.periodo.ate,
      dias: f.periodo.dias,
      rotulo: rotuloPeriodo(f.periodo),
      anteriorDe: f.periodo.anteriorDe,
      anteriorAte: f.periodo.anteriorAte,
    },
    frota: {
      motoristasMonitorados: kpis.aoVivo.motoristasMonitorados,
      motoristasAtivosAgora: kpis.aoVivo.motoristasAtivos,
      emRiscoAgora: kpis.aoVivo.motoristasEmRisco,
      fadigaMediaAgora: kpis.aoVivo.fadigaMedia,
      fadigaMediaPeriodo: kpis.periodo.fadigaMedia,
      fadigaMediaPeriodoAnterior: kpis.periodo.fadigaMediaAnterior,
      variacaoFadigaPercentual: variacaoPercentual(kpis.periodo.fadigaMedia, kpis.periodo.fadigaMediaAnterior),
      alertasPeriodo: kpis.periodo.alertas,
      alertasPeriodoAnterior: kpis.periodo.alertasAnterior,
      alertasGravesPeriodo: kpis.periodo.alertasGraves,
      alertasAbertosGraves: (abertos[0]?.total as number) ?? 0,
      horasDirigidasPeriodo: kpis.periodo.horasDirigidas,
      turnosPeriodo: kpis.periodo.turnos,
    },
    horarioCritico: kpis.horarioCritico
      ? {
          inicio: kpis.horarioCritico.inicio,
          fim: kpis.horarioCritico.fim,
          percentual: kpis.horarioCritico.percentual,
          madrugadaPercentual: kpis.horarioCritico.madrugadaPercentual,
        }
      : null,
    fadigaPorHoraDirecao: tendencia.pontos.map((p) => ({ hora: p.hora, fadiga: p.fadiga, alertas: p.alertas })),
    porTipoVeiculo: porTipo.map((t) => ({
      tipo: ROTULO_TIPO_VEICULO[t.tipo_veiculo as string] ?? (t.tipo_veiculo as string),
      fadiga: t.fadiga as number | null,
      alertas: t.alertas as number,
    })),
    porRegiao: porRegiao.map((r) => ({ regiao: r.macro_regiao as string, fadiga: r.fadiga as number | null, alertas: r.alertas as number })),
    tiposAlerta: tipos.map((t) => ({ tipo: dashboard.ROTULO_ALERTA[t.tipo as string] ?? (t.tipo as string), total: t.total as number })),
    motoristasRisco: ranking
      .filter((r) => r.codigo)
      .map((r) => ({
        codigo: r.codigo as string,
        fadigaMedia30d: r.score_fadiga_medio as number | null,
        alertas30d: r.alertas_30d as number,
        alertasGraves30d: r.alertas_graves_30d as number,
        horasDirigidas30d: r.horas_dirigidas_30d as number | null,
        nivel: r.nivel_risco as string,
        agora: r.ativo ? { score: r.score_atual as number | null, horasTurno: r.horas_turno as number | null } : null,
      })),
    emRiscoAgora: emRisco
      .filter((m) => m.codigo)
      .map((m) => ({ codigo: m.codigo as string, score: m.score_atual as number, horasTurno: m.horas_turno as number | null })),
    rotas: rotas.slice(0, 6).map((r) => ({
      rota: `${r.origemCidade} → ${r.destinoCidade}`,
      fadiga: r.fadiga as number | null,
      alertas: r.eventos as number,
      tendencia: r.tendencia,
      prfAcidentesSono: r.prf?.acidentesSono ?? null,
    })),
    prf: "janelaAte" in prf ? { janelaAte: prf.janelaAte, acidentesSonoPesados: sonoPesados, madrugadaPercentual: madrugadaPrf } : null,
    roi: {
      disponivel: calc.disponivel,
      acidentesEvitadosAno: calc.disponivel ? calc.cenarios.conservador.acidentesEvitados : null,
      custoEvitadoAno: calc.disponivel ? calc.cenarios.conservador.custoEvitado : null,
      reducaoPercentual: calc.reducaoAcidentesSonoPercentual,
    },
    atendimento: {
      graves30d: calc.alertasAtendidos30d.graves,
      atendidos30d: calc.alertasAtendidos30d.atendidos,
      percentual: arred(calc.alertasAtendidos30d.percentual, 0),
    },
    acidentesFrota: {
      total: noPeriodo.length,
      porSono: sonoFrota.length,
      totalAnterior: anteriores.length,
      porSonoAnterior: anteriores.filter((a) => a.relacionado_sonolencia).length,
      ultimoPorSono: sonoFrota[0]
        ? {
            codigo: sonoFrota[0].codigo as string | null,
            quando: new Date(sonoFrota[0].ocorrido_em as string).toISOString(),
            horaLocal: sonoFrota[0].hora_local as string,
            descricao: sonoFrota[0].descricao as string | null,
          }
        : null,
    },
  };
}
