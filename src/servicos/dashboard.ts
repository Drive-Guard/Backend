/**
 * Consultas da visão geral da dashboard.
 *
 * Tudo filtra pela empresa do usuário. As agregações de período leem as views
 * Gold e recompõem as médias a partir das somas e contagens (média de médias
 * daria número errado ao juntar dias, regiões e tipos de veículo).
 */

import type { Usuario } from "../lib/auth";
import { db, type Sql } from "../lib/db";
import { condicoesDimensao, type Filtros, ROTULO_TIPO_VEICULO } from "../lib/filtros";
import { invalido } from "../lib/http";
import { nivelRisco, variacaoPercentual, arred } from "../lib/numeros";
import { diaLocal, diasEntre, listaDias, somarDias } from "../lib/tempo";

/** Leitura mais antiga que isto não conta como "ao vivo". */
export const JANELA_AO_VIVO = "30 minutes";

export const ROTULO_ALERTA: Record<string, string> = {
  sonolencia: "Sonolência",
  microssono: "Microssono",
  bocejo_excessivo: "Bocejos",
  cabeca_baixa: "Cabeça inclinada",
  distracao: "Distração",
  perda_de_face: "Rosto fora da câmera",
  piscadas_excessivas: "Piscadas excessivas",
  fechamento_prolongado: "Fechamento ocular prolongado",
};

/** Alertas da Silver com as mesmas dimensões das views Gold (para os filtros). */
export function alertasComDimensoes(sql: Sql, empresaId: string) {
  return sql`
    SELECT a.*, COALESCE(u.macro_regiao, 'ND') AS macro_regiao, COALESCE(m.regiao_uf, 'ND') AS regiao_uf,
           COALESCE(v.tipo::text, 'nd') AS tipo_veiculo
      FROM silver.alertas a
      JOIN silver.motoristas m ON m.id = a.motorista_id
      LEFT JOIN silver.dim_uf u ON u.uf = m.regiao_uf
      LEFT JOIN silver.veiculos v ON v.id = a.veiculo_id
     WHERE m.empresa_id = ${empresaId}
  `;
}

// ---------------------------------------------------------------------------
// KPIs do topo
// ---------------------------------------------------------------------------

export async function horarioCritico(sql: Sql, u: Usuario, f: Filtros) {
  const dims = condicoesDimensao(sql, f);
  const porHora = await sql<{ hora: number; total: number }[]>`
    SELECT hora, SUM(total)::int AS total
      FROM gold.mv_alertas_agregados
     WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate} ${dims}
     GROUP BY hora
  `;
  const totais = Array.from({ length: 24 }, (_, h) => porHora.find((r) => r.hora === h)?.total ?? 0);
  const total = totais.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  // Janela de 2 horas seguidas com mais alertas (03:00-05:00 = horas 3 e 4).
  let melhor = 0;
  for (let h = 1; h < 24; h++) {
    if (totais[h] + totais[(h + 1) % 24] > totais[melhor] + totais[(melhor + 1) % 24]) melhor = h;
  }
  const naJanela = totais[melhor] + totais[(melhor + 1) % 24];
  const madrugada = totais.slice(0, 6).reduce((a, b) => a + b, 0);
  const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

  return {
    inicio: hh(melhor),
    fim: hh(melhor + 2),
    alertasNaJanela: naJanela,
    percentual: arred((naJanela / total) * 100, 0),
    madrugadaPercentual: arred((madrugada / total) * 100, 0),
    totalAlertas: total,
    porHora: totais,
  };
}

export async function kpis(u: Usuario, f: Filtros) {
  const sql = db();
  const dims = condicoesDimensao(sql, f);

  const [[aoVivo], [alertas], [periodo], [anterior], critico] = await Promise.all([
    sql`
      SELECT COUNT(*) FILTER (WHERE ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval)::int AS ativos,
             COUNT(*) FILTER (WHERE ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval
                                AND risco IN ('high', 'critical'))::int                  AS em_risco,
             ROUND(AVG(score_atual) FILTER (WHERE ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval), 1) AS fadiga_media,
             COUNT(*)::int AS monitorados
        FROM gold.vw_frota_agora
       WHERE empresa_id = ${u.empresaId} ${dims}
    `,
    sql`
      SELECT COUNT(*) FILTER (WHERE disparado_em >= now() - interval '24 hours')::int AS ultimas_24h,
             COUNT(*) FILTER (WHERE disparado_em <  now() - interval '24 hours')::int AS anteriores_24h
        FROM (${alertasComDimensoes(sql, u.empresaId)}) a
       WHERE disparado_em >= now() - interval '48 hours' ${dims}
    `,
    agregadoPeriodo(sql, u, f, f.periodo.de, f.periodo.ate),
    agregadoPeriodo(sql, u, f, f.periodo.anteriorDe, f.periodo.anteriorAte),
    horarioCritico(sql, u, f),
  ]);

  return {
    aoVivo: {
      motoristasAtivos: aoVivo.ativos,
      motoristasEmRisco: aoVivo.em_risco,
      motoristasMonitorados: aoVivo.monitorados,
      fadigaMedia: aoVivo.fadiga_media,
    },
    alertas24h: {
      total: alertas.ultimas_24h,
      anterior: alertas.anteriores_24h,
      variacao: variacaoPercentual(alertas.ultimas_24h, alertas.anteriores_24h),
    },
    horarioCritico: critico,
    periodo: {
      de: f.periodo.de,
      ate: f.periodo.ate,
      fadigaMedia: periodo.fadiga_media,
      fadigaMediaAnterior: anterior.fadiga_media,
      variacaoFadiga: variacaoPercentual(periodo.fadiga_media, anterior.fadiga_media),
      alertas: periodo.alertas,
      alertasAnterior: anterior.alertas,
      variacaoAlertas: variacaoPercentual(periodo.alertas, anterior.alertas),
      alertasGraves: periodo.alertas_graves,
      turnos: periodo.turnos,
      horasDirigidas: periodo.horas,
      kmRodados: periodo.km,
      leituras: periodo.leituras,
    },
  };
}

export function agregadoPeriodo(sql: Sql, u: Usuario, f: Filtros, de: string, ate: string) {
  return sql`
    SELECT ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS fadiga_media,
           COALESCE(SUM(total_leituras), 0)::int                   AS leituras,
           COALESCE(SUM(total_alertas), 0)::int                    AS alertas,
           COALESCE(SUM(alertas_graves), 0)::int                   AS alertas_graves,
           COALESCE(SUM(total_turnos), 0)::int                     AS turnos,
           ROUND(COALESCE(SUM(soma_minutos_turno), 0) / 60.0, 1)   AS horas,
           ROUND(COALESCE(SUM(distancia_total_km), 0), 0)          AS km
      FROM gold.mv_kpis_diarios
     WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${de} AND ${ate} ${condicoesDimensao(sql, f)}
  `;
}

// ---------------------------------------------------------------------------
// Tempo real
// ---------------------------------------------------------------------------

export async function alertasTempoReal(u: Usuario, f: Filtros) {
  const sql = db();
  const dims = condicoesDimensao(sql, f);
  const [motoristas, eventos] = await Promise.all([
    sql`
      SELECT motorista_id, codigo, nome, score_atual, risco, tendencia, blink_rate,
             duracao_olhos_fechados_ms, horas_turno, tipo_veiculo, regiao_uf, placa,
             veiculo_codigo, alertas_hoje, ultima_leitura_em
        FROM gold.vw_frota_agora
       WHERE empresa_id = ${u.empresaId}
         AND ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval
         AND score_atual >= 60 ${dims}
       ORDER BY score_atual DESC
       LIMIT 8
    `,
    sql`
      SELECT a.id, a.disparado_em, a.tipo::text AS tipo, a.gravidade::text AS gravidade,
             a.status::text AS status, a.score_fadiga, m.codigo, m.nome_exibicao AS nome
        FROM (${alertasComDimensoes(sql, u.empresaId)}) a
        JOIN silver.motoristas m ON m.id = a.motorista_id
       WHERE a.disparado_em >= now() - interval '6 hours' ${dims}
       ORDER BY a.disparado_em DESC
       LIMIT 12
    `,
  ]);

  return {
    motoristas: motoristas.map((m) => ({
      motoristaId: m.motorista_id,
      codigo: m.codigo,
      nome: m.nome,
      score: m.score_atual,
      risco: m.risco,
      tendencia: m.tendencia,
      blinkRate: m.blink_rate,
      fechamentoOlhosMs: m.duracao_olhos_fechados_ms,
      horasTurno: m.horas_turno,
      tipoVeiculo: ROTULO_TIPO_VEICULO[m.tipo_veiculo as string] ?? m.tipo_veiculo,
      regiao: m.regiao_uf,
      placa: m.placa,
      veiculoCodigo: m.veiculo_codigo,
      alertasHoje: m.alertas_hoje,
      ultimaLeituraEm: m.ultima_leitura_em,
    })),
    eventos: eventos.map((e) => ({
      id: e.id,
      disparadoEm: e.disparado_em,
      tipo: e.tipo,
      rotulo: ROTULO_ALERTA[e.tipo as string] ?? e.tipo,
      gravidade: e.gravidade,
      status: e.status,
      score: e.score_fadiga,
      codigo: e.codigo,
      nome: e.nome,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tendência ao longo do turno
// ---------------------------------------------------------------------------

export async function tendenciaTurno(u: Usuario, f: Filtros) {
  const sql = db();
  const dims = condicoesDimensao(sql, f);
  const hoje = diaLocal();

  const [porHora, sinais, [vivo], [ontem], [eventos24h]] = await Promise.all([
    sql<{ hora_direcao: number; fadiga: number | null; leituras: number; alertas: number }[]>`
      SELECT hora_direcao,
             ROUND(SUM(soma_score) / NULLIF(SUM(leituras), 0), 1) AS fadiga,
             SUM(leituras)::int AS leituras, SUM(alertas)::int AS alertas
        FROM gold.mv_fadiga_por_tempo_direcao
       WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
         AND hora_direcao < 12 ${dims}
       GROUP BY hora_direcao
       ORDER BY hora_direcao
    `,
    sql<{ tipo: string; total: number }[]>`
      SELECT tipo, SUM(total)::int AS total
        FROM gold.mv_alertas_agregados
       WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate} ${dims}
       GROUP BY tipo ORDER BY 2 DESC LIMIT 3
    `,
    sql`
      SELECT ROUND(AVG(score_atual), 1) AS score
        FROM gold.vw_frota_agora
       WHERE empresa_id = ${u.empresaId} AND ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval ${dims}
    `,
    sql`
      SELECT ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS score
        FROM gold.mv_kpis_diarios
       WHERE empresa_id = ${u.empresaId} AND dia = ${somarDias(hoje, -1)} ${dims}
    `,
    sql`
      SELECT COUNT(*)::int AS total
        FROM (${alertasComDimensoes(sql, u.empresaId)}) a
       WHERE disparado_em >= now() - interval '24 hours' ${dims}
    `,
  ]);

  const pontos = Array.from({ length: 12 }, (_, h) => {
    const r = porHora.find((p) => p.hora_direcao === h);
    return { hora: `${h + 1}h`, horaDirecao: h, fadiga: r?.fadiga ?? null, leituras: r?.leituras ?? 0, alertas: r?.alertas ?? 0 };
  });
  const comDados = pontos.filter((p) => p.fadiga !== null);
  const pico = comDados.reduce<(typeof pontos)[number] | null>((m, p) => (!m || p.fadiga! > m.fadiga! ? p : m), null);
  const acimaDoLimite = comDados.find((p) => p.fadiga! >= 70);

  return {
    pontos,
    limiteAlerta: 70,
    resumo: {
      pico: pico ? { hora: pico.hora, fadiga: pico.fadiga } : null,
      primeiraHoraAcimaDoLimite: acimaDoLimite?.hora ?? null,
      sinais: sinais.map((s) => ({ tipo: s.tipo, rotulo: ROTULO_ALERTA[s.tipo] ?? s.tipo, total: s.total })),
      eventosPorHora: arred(eventos24h.total / 24, 1),
      scoreAtual: vivo.score,
      scoreOntem: ontem.score,
      variacaoVsOntem: vivo.score !== null && ontem.score !== null ? arred(vivo.score - ontem.score, 1) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Evolução da fadiga
// ---------------------------------------------------------------------------

export async function evolucaoFadiga(u: Usuario, f: Filtros) {
  const sql = db();
  const dims = condicoesDimensao(sql, f);
  const [linhas, [atual], [anterior]] = await Promise.all([
    sql<{ dia: string; fadiga: number | null; alertas: number }[]>`
      SELECT dia::text AS dia,
             ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS fadiga,
             SUM(total_alertas)::int AS alertas
        FROM gold.mv_kpis_diarios
       WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate} ${dims}
       GROUP BY dia ORDER BY dia
    `,
    agregadoPeriodo(sql, u, f, f.periodo.de, f.periodo.ate),
    agregadoPeriodo(sql, u, f, f.periodo.anteriorDe, f.periodo.anteriorAte),
  ]);

  const porDia = new Map(linhas.map((l) => [l.dia, l]));
  return {
    serie: listaDias(f.periodo.de, f.periodo.ate).map((dia) => ({
      dia,
      fadiga: porDia.get(dia)?.fadiga ?? null,
      alertas: porDia.get(dia)?.alertas ?? 0,
    })),
    fadigaMedia: atual.fadiga_media,
    fadigaMediaAnterior: anterior.fadiga_media,
    variacao: variacaoPercentual(atual.fadiga_media, anterior.fadiga_media),
    limiteAlerta: 70,
  };
}

// ---------------------------------------------------------------------------
// Rotas com maior incidência (+ cruzamento com a PRF)
// ---------------------------------------------------------------------------

export async function rotas(u: Usuario, f: Filtros) {
  const sql = db();
  const linhas = await sql`
    WITH atual AS (
        SELECT rota_id, SUM(soma_score) AS soma, SUM(leituras) AS leituras, SUM(alertas) AS alertas,
               SUM(alertas_graves) AS graves, SUM(turnos) AS turnos
          FROM gold.mv_rotas_desempenho
         WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
         GROUP BY rota_id
    ),
    anterior AS (
        SELECT rota_id, SUM(soma_score) / NULLIF(SUM(leituras), 0) AS fadiga
          FROM gold.mv_rotas_desempenho
         WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.anteriorDe} AND ${f.periodo.anteriorAte}
         GROUP BY rota_id
    ),
    janela_prf AS (
        SELECT MAX(mes) AS ultimo FROM gold.mv_prf_trechos
    ),
    prf AS (
        SELECT r.id AS rota_id,
               SUM(t.acidentes)::int              AS acidentes,
               SUM(t.acidentes_sono)::int         AS acidentes_sono,
               SUM(t.acidentes_pesados_sono)::int AS acidentes_pesados_sono,
               SUM(t.mortos)::int                 AS mortos
          FROM silver.rotas r
          JOIN gold.mv_prf_trechos t ON t.br = ANY (r.brs) AND t.uf = ANY (r.ufs_percorridas::text[])
          CROSS JOIN janela_prf j
         WHERE r.empresa_id = ${u.empresaId}
           AND t.mes > j.ultimo - interval '12 months'
         GROUP BY r.id
    )
    SELECT r.id, r.nome, r.origem_cidade, r.origem_uf, r.destino_cidade, r.destino_uf, r.brs,
           r.distancia_km,
           ROUND(a.soma / NULLIF(a.leituras, 0), 1) AS fadiga,
           ROUND(an.fadiga, 1)                      AS fadiga_anterior,
           COALESCE(a.alertas, 0)::int              AS alertas,
           COALESCE(a.graves, 0)::int               AS alertas_graves,
           COALESCE(a.turnos, 0)::int               AS turnos,
           p.acidentes, p.acidentes_sono, p.acidentes_pesados_sono, p.mortos
      FROM silver.rotas r
      JOIN atual a ON a.rota_id = r.id
      LEFT JOIN anterior an ON an.rota_id = r.id
      LEFT JOIN prf p ON p.rota_id = r.id
     WHERE r.empresa_id = ${u.empresaId} AND a.leituras > 0
     ORDER BY fadiga DESC NULLS LAST
  `;

  return linhas.map((r) => ({
    rotaId: r.id,
    nome: r.nome,
    origem: `${r.origem_cidade}/${r.origem_uf}`,
    destino: `${r.destino_cidade}/${r.destino_uf}`,
    origemCidade: r.origem_cidade,
    destinoCidade: r.destino_cidade,
    brs: r.brs,
    distanciaKm: r.distancia_km,
    fadiga: r.fadiga,
    eventos: r.alertas,
    alertasGraves: r.alertas_graves,
    turnos: r.turnos,
    risco: nivelRisco(r.fadiga as number | null),
    tendencia: variacaoPercentual(r.fadiga as number | null, r.fadiga_anterior as number | null),
    prf: r.acidentes === null || r.acidentes === undefined ? null : {
      acidentes: r.acidentes,
      acidentesSono: r.acidentes_sono,
      acidentesPesadosSono: r.acidentes_pesados_sono,
      mortos: r.mortos,
    },
  }));
}

// ---------------------------------------------------------------------------
// Heatmap: horas de direção x dia
// ---------------------------------------------------------------------------

export const FAIXAS_HEATMAP = ["0–2h", "2–4h", "4–6h", "6–8h", "8–10h", "10–12h"];

export async function heatmap(u: Usuario, f: Filtros, query: Record<string, string | undefined>) {
  const sql = db();
  // Padrão: últimos 7 dias. Com o calendário, o intervalo escolhido (até 31 dias).
  const hoje = diaLocal();
  const de = query.de ?? somarDias(hoje, -6);
  const ate = query.ate ?? hoje;
  if (de > ate) throw invalido("A data inicial é posterior à final");
  if (diasEntre(de, ate) > 31) throw invalido("O heatmap mostra no máximo 31 dias");

  const linhas = await sql<{ dia: string; faixa: number; leituras: number; sonolento: number; fadiga: number | null; alertas: number }[]>`
    SELECT dia::text AS dia, hora_direcao / 2 AS faixa,
           SUM(leituras)::int AS leituras, SUM(leituras_sonolento)::int AS sonolento,
           ROUND(SUM(soma_score) / NULLIF(SUM(leituras), 0), 1) AS fadiga,
           SUM(alertas)::int AS alertas
      FROM gold.mv_fadiga_por_tempo_direcao
     WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${de} AND ${ate} AND hora_direcao < 12
           ${condicoesDimensao(sql, f)}
     GROUP BY 1, 2
  `;

  const dias = listaDias(de, ate);
  const celula = (dia: string, faixa: number) => linhas.find((l) => l.dia === dia && l.faixa === faixa);
  return {
    de,
    ate,
    dias,
    faixas: FAIXAS_HEATMAP,
    // Probabilidade de sonolência = % das leituras classificadas como sonolento.
    valores: FAIXAS_HEATMAP.map((_, faixa) =>
      dias.map((dia) => {
        const c = celula(dia, faixa);
        return c && c.leituras > 0 ? Math.round((c.sonolento / c.leituras) * 100) : null;
      }),
    ),
    detalhes: FAIXAS_HEATMAP.map((_, faixa) =>
      dias.map((dia) => {
        const c = celula(dia, faixa);
        return c ? { leituras: c.leituras, fadiga: c.fadiga, alertas: c.alertas } : null;
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Fadiga vs tempo de direção
// ---------------------------------------------------------------------------

export async function fadigaTempoDirecao(u: Usuario, f: Filtros) {
  const sql = db();
  const linhas = await sql<{ faixa: number; fadiga: number | null; leituras: number; alertas: number }[]>`
    SELECT hora_direcao / 2 AS faixa,
           ROUND(SUM(soma_score) / NULLIF(SUM(leituras), 0), 1) AS fadiga,
           SUM(leituras)::int AS leituras, SUM(alertas)::int AS alertas
      FROM gold.mv_fadiga_por_tempo_direcao
     WHERE empresa_id = ${u.empresaId} AND dia BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
       AND hora_direcao < 12 ${condicoesDimensao(sql, f)}
     GROUP BY 1 ORDER BY 1
  `;
  return FAIXAS_HEATMAP.map((rotulo, faixa) => {
    const l = linhas.find((x) => x.faixa === faixa);
    // O ponto fica no meio da faixa: 0–2h -> 1h.
    return { faixa: rotulo, horas: faixa * 2 + 1, fadiga: l?.fadiga ?? null, eventos: l?.alertas ?? 0, leituras: l?.leituras ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Base comparativa da PRF (sempre os 12 meses mais recentes carregados)
// ---------------------------------------------------------------------------

export interface FiltroPrf {
  ufs: string[] | null;
  pesados: boolean;
}

export async function filtroPrf(f: Filtros, query: Record<string, string | undefined>): Promise<FiltroPrf> {
  const pesados = query.pesados !== "false";
  if (!f.regiao) return { ufs: null, pesados };
  if (f.regiao.tipo === "uf") return { ufs: [f.regiao.valor], pesados };
  const sql = db();
  const ufs = await sql<{ uf: string }[]>`SELECT uf FROM silver.dim_uf WHERE macro_regiao = ${f.regiao.valor}`;
  return { ufs: ufs.map((x) => x.uf), pesados };
}

/** Os 12 meses mais recentes da base carregada: de (mês inicial) a ate (último mês). */
export async function janelaPrf(sql: Sql) {
  const [j] = await sql<{ ultimo: string | null; primeiro: string | null; carregado_em: Date | null }[]>`
    SELECT MAX(mes)::text AS ultimo,
           (MAX(mes) - interval '11 months')::date::text AS primeiro,
           (SELECT MAX(concluido_em) FROM silver.prf_cargas WHERE status = 'ok') AS carregado_em
      FROM gold.mv_prf_trechos
  `;
  if (!j.ultimo) return null;
  return { de: j.primeiro!, ate: j.ultimo, carregadoEm: j.carregado_em };
}

function condicaoPrf(sql: Sql, fp: FiltroPrf, ultimoMes: string) {
  const ufs = fp.ufs ? sql`AND uf = ANY (${sql.array(fp.ufs)})` : sql``;
  const pesados = fp.pesados ? sql`AND veiculo_pesado` : sql``;
  return sql`AND mes > ${ultimoMes}::date - interval '12 months' ${ufs} ${pesados}`;
}

const FONTE_PRF = {
  fonte: "PRF — Dados Abertos (acidentes em rodovias federais)",
  url: "https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf",
};

export async function prfResumo(f: Filtros, query: Record<string, string | undefined>) {
  const sql = db();
  const j = await janelaPrf(sql);
  if (!j) return { carregada: false, ...FONTE_PRF };
  const fp = await filtroPrf(f, query);

  const [[totais], perfil] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(total_incidentes), 0)::int AS acidentes,
             COALESCE(SUM(incidentes_sonolencia), 0)::int AS sono,
             COALESCE(SUM(total_mortos), 0)::int AS mortos
        FROM gold.mv_prf_faixa_horaria
       WHERE TRUE ${condicaoPrf(sql, fp, j.ate)}
    `,
    sql`
      SELECT ano, recorte, acidentes::int, fatais::int, com_feridos::int, sem_vitimas::int, mortos::int
        FROM gold.mv_prf_perfil_sono
       WHERE recorte = 'pesados_sono'
       ORDER BY ano DESC
    `,
  ]);

  return {
    carregada: true,
    ...FONTE_PRF,
    janela: { de: j.de.slice(0, 7), ate: j.ate.slice(0, 7), carregadoEm: j.carregadoEm },
    recorte: { ufs: fp.ufs, veiculosPesados: fp.pesados },
    acidentes: totais.acidentes,
    acidentesSono: totais.sono,
    percentualSono: totais.acidentes ? arred((totais.sono / totais.acidentes) * 100, 1) : null,
    mortos: totais.mortos,
    perfilPesadosSonoPorAno: perfil,
  };
}

export async function prfFaixaHoraria(f: Filtros, query: Record<string, string | undefined>) {
  const sql = db();
  const j = await janelaPrf(sql);
  if (!j) return { carregada: false, faixas: [], ...FONTE_PRF };
  const fp = await filtroPrf(f, query);
  const linhas = await sql`
    SELECT faixa_horaria, ordem_faixa, SUM(total_incidentes)::int AS acidentes,
           SUM(incidentes_sonolencia)::int AS sono, SUM(total_mortos)::int AS mortos
      FROM gold.mv_prf_faixa_horaria
     WHERE TRUE ${condicaoPrf(sql, fp, j.ate)}
     GROUP BY 1, 2 ORDER BY 2
  `;
  const rotulos: Record<string, string> = { madrugada: "Madrugada 0h–6h", manha: "Manhã 6h–12h", tarde: "Tarde 12h–18h", noite: "Noite 18h–0h" };
  const totalSono = linhas.reduce((a, l) => a + (l.sono as number), 0);
  return {
    carregada: true,
    ...FONTE_PRF,
    janelaAte: j.ate.slice(0, 7),
    veiculosPesados: fp.pesados,
    faixas: linhas.map((l) => ({
      faixa: l.faixa_horaria,
      rotulo: rotulos[l.faixa_horaria as string],
      acidentes: l.acidentes,
      acidentesSono: l.sono,
      mortos: l.mortos,
      percentualSono: totalSono ? arred(((l.sono as number) / totalSono) * 100, 0) : 0,
    })),
  };
}

export async function prfCausas(f: Filtros, query: Record<string, string | undefined>) {
  const sql = db();
  const j = await janelaPrf(sql);
  if (!j) return { carregada: false, causas: [], ...FONTE_PRF };
  const fp = await filtroPrf(f, query);
  const linhas = await sql`
    SELECT causa, SUM(total_incidentes)::int AS acidentes, SUM(total_mortos)::int AS mortos,
           BOOL_OR(causa_ligada_a_sono) AS sono
      FROM gold.mv_prf_causas_mes
     WHERE TRUE ${condicaoPrf(sql, fp, j.ate)}
     GROUP BY causa ORDER BY 2 DESC
  `;
  const top = linhas.slice(0, 6);
  const resto = linhas.slice(6);
  // Sono sempre aparece, mesmo fora do top 6: é o recorte do DriveGuard.
  const sono = resto.find((l) => l.sono);
  const outras = resto.filter((l) => l !== sono);
  const lista = [...top, ...(sono ? [sono] : [])].map((l) => ({
    causa: l.causa,
    acidentes: l.acidentes,
    mortos: l.mortos,
    ligadaASono: l.sono,
  }));
  if (outras.length) {
    lista.push({
      causa: "Outras causas",
      acidentes: outras.reduce((a, l) => a + (l.acidentes as number), 0),
      mortos: outras.reduce((a, l) => a + (l.mortos as number), 0),
      ligadaASono: false,
    });
  }
  return { carregada: true, ...FONTE_PRF, janelaAte: j.ate.slice(0, 7), veiculosPesados: fp.pesados, causas: lista };
}

export async function prfMapa(f: Filtros, query: Record<string, string | undefined>) {
  const sql = db();
  const j = await janelaPrf(sql);
  if (!j) return { carregada: false, cidades: [], ...FONTE_PRF };
  const fp = await filtroPrf(f, query);
  const linhas = await sql`
    SELECT uf, municipio, SUM(total_incidentes)::int AS acidentes,
           SUM(incidentes_sonolencia)::int AS sono, SUM(incidentes_fatais)::int AS fatais,
           SUM(total_mortos)::int AS mortos,
           SUM(soma_latitude) / NULLIF(SUM(pontos_com_coordenada), 0) AS latitude,
           SUM(soma_longitude) / NULLIF(SUM(pontos_com_coordenada), 0) AS longitude
      FROM gold.mv_prf_hotspots
     WHERE TRUE ${condicaoPrf(sql, fp, j.ate)}
     GROUP BY uf, municipio
    HAVING SUM(incidentes_sonolencia) > 0 AND SUM(pontos_com_coordenada) > 0
     ORDER BY sono DESC, acidentes DESC
     LIMIT 15
  `;
  const maximo = Math.max(1, ...linhas.map((l) => l.sono as number));
  return {
    carregada: true,
    ...FONTE_PRF,
    janelaAte: j.ate.slice(0, 7),
    veiculosPesados: fp.pesados,
    cidades: linhas.map((l) => {
      const proporcao = (l.sono as number) / maximo;
      return {
        cidade: l.municipio,
        uf: l.uf,
        acidentesSono: l.sono,
        acidentes: l.acidentes,
        fatais: l.fatais,
        mortos: l.mortos,
        latitude: arred(l.latitude as number, 4),
        longitude: arred(l.longitude as number, 4),
        severidade: proporcao >= 0.75 ? "critical" : proporcao >= 0.5 ? "high" : proporcao >= 0.25 ? "medium" : "low",
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Exportação CSV (estado atual)
// ---------------------------------------------------------------------------

export async function exportarCsv(u: Usuario, f: Filtros): Promise<string> {
  const sql = db();
  const linhas = await sql`
    SELECT codigo, nome, tipo_veiculo, placa, veiculo_codigo, regiao_uf, horas_turno, score_atual, risco,
           alertas_hoje, ultima_leitura_em
      FROM gold.vw_frota_agora
     WHERE empresa_id = ${u.empresaId} ${condicoesDimensao(sql, f)}
     ORDER BY score_atual DESC
  `;
  const cab = ["Código", "Motorista", "Veículo", "Placa", "Câmera", "UF", "Turno (h)", "Fadiga", "Risco", "Alertas hoje", "Última leitura"];
  const rotuloRisco: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", critical: "crítico", sem_dados: "sem dados" };
  const linhasCsv = linhas.map((l) => [
    l.codigo ?? "",
    l.nome,
    ROTULO_TIPO_VEICULO[l.tipo_veiculo as string] ?? l.tipo_veiculo,
    l.placa ?? "",
    l.veiculo_codigo ?? "",
    l.regiao_uf,
    l.horas_turno ?? "",
    l.score_atual,
    rotuloRisco[l.risco as string] ?? l.risco,
    l.alertas_hoje,
    l.ultima_leitura_em ? new Date(l.ultima_leitura_em as Date).toISOString() : "",
  ]);
  return [cab, ...linhasCsv].map((l) => l.map(celulaCsv).join(";")).join("\r\n");
}

export function celulaCsv(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
