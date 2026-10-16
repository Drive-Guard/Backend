/**
 * Dados dos relatórios e da aba Relatórios, com os filtros da tela.
 *
 * Período, região e tipo de veículo valem para tudo. Risco do motorista,
 * veículo e faixa horária refinam o que vem da Silver (alertas, turnos e a
 * série de fadiga quando há veículo ou risco escolhido).
 */

import { z } from "zod";
import type { Usuario } from "../../lib/auth";
import { db, type Sql } from "../../lib/db";
import { condicoesDimensao, lerFiltros, ROTULO_TIPO_VEICULO, TIPOS_VEICULO, type Filtros } from "../../lib/filtros";
import { arred, formatarNumero, formatarReais, variacaoPercentual } from "../../lib/numeros";
import { formatarDiaBr, listaDias } from "../../lib/tempo";
import * as dashboard from "../dashboard";
import * as insights from "../insights";
import * as roi from "../roi";
import { TITULO_RELATORIO, type Documento, type Secao, type TipoRelatorio } from "./documento";

export const schemaFiltrosRelatorio = z.object({
  periodo: z.enum(["hoje", "7d", "30d", "90d", "ano"]).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  regiao: z.string().max(20).optional(),
  tipo_veiculo: z.enum(TIPOS_VEICULO).optional(),
  risco: z.enum(["critico", "alto", "medio", "baixo"]).optional(),
  veiculo_id: z.string().uuid().optional(),
  faixa_horaria: z.enum(["madrugada", "manha", "tarde", "noite"]).optional(),
});
export type FiltrosRelatorio = z.infer<typeof schemaFiltrosRelatorio>;

const RISCO_PARA_NIVEL: Record<string, string> = { critico: "critical", alto: "high", medio: "medium", baixo: "low" };
const FAIXAS: Record<string, [number, number]> = { madrugada: [0, 5], manha: [6, 11], tarde: [12, 17], noite: [18, 23] };
const ROTULO_FAIXA: Record<string, string> = { madrugada: "madrugada", manha: "manhã", tarde: "tarde", noite: "noite" };
const ROTULO_RISCO: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", critical: "crítico", sem_dados: "sem dados" };

export interface Contexto {
  u: Usuario;
  f: Filtros;
  r: FiltrosRelatorio;
}

export function contexto(u: Usuario, filtros: FiltrosRelatorio): Contexto {
  const r = schemaFiltrosRelatorio.parse(filtros);
  return { u, r, f: lerFiltros({ periodo: r.periodo, de: r.de, ate: r.ate, regiao: r.regiao, tipo_veiculo: r.tipo_veiculo }) };
}

/** Condições extras da Silver (alias: a = alertas ou t = turnos, m = motoristas, v = veículos). */
function refinamentos(sql: Sql, c: Contexto, coluna: { veiculo: string; hora?: string }) {
  const partes = [];
  if (c.r.veiculo_id) partes.push(sql`AND ${sql(coluna.veiculo)} = ${c.r.veiculo_id}`);
  if (c.r.risco) {
    partes.push(sql`AND EXISTS (SELECT 1 FROM gold.mv_ranking_motoristas rk WHERE rk.motorista_id = m.id AND rk.nivel_risco = ${RISCO_PARA_NIVEL[c.r.risco]})`);
  }
  if (c.r.faixa_horaria && coluna.hora) {
    const [h0, h1] = FAIXAS[c.r.faixa_horaria];
    partes.push(sql`AND EXTRACT(HOUR FROM ${sql(coluna.hora)} AT TIME ZONE 'America/Sao_Paulo') BETWEEN ${h0} AND ${h1}`);
  }
  return partes.reduce((acc, p) => sql`${acc} ${p}`, sql``);
}

function dimensoesSilver(sql: Sql, c: Contexto) {
  const partes = [];
  if (c.f.regiao?.tipo === "macro") partes.push(sql`AND uf.macro_regiao = ${c.f.regiao.valor}`);
  if (c.f.regiao?.tipo === "uf") partes.push(sql`AND m.regiao_uf = ${c.f.regiao.valor}`);
  if (c.f.tipoVeiculo) partes.push(sql`AND v.tipo = ${c.f.tipoVeiculo}::silver.tipo_veiculo`);
  return partes.reduce((acc, p) => sql`${acc} ${p}`, sql``);
}

function alertasFiltrados(sql: Sql, c: Contexto, de = c.f.periodo.de, ate = c.f.periodo.ate) {
  return sql`
    SELECT a.*, m.codigo, m.nome_exibicao AS motorista, v.placa, v.tipo::text AS tipo_veiculo,
           -- Mesma definição de "atendido" do ROI (gold.mv_alertas_agregados).
           EXISTS (SELECT 1 FROM silver.acoes_motorista ac WHERE ac.alerta_id = a.id
                     AND ac.tipo IN ('pausa_obrigatoria', 'contato_telefonico', 'encerramento_turno', 'troca_motorista')) AS atendido
      FROM silver.alertas a
      JOIN silver.motoristas m ON m.id = a.motorista_id
      LEFT JOIN silver.dim_uf uf ON uf.uf = m.regiao_uf
      LEFT JOIN silver.veiculos v ON v.id = a.veiculo_id
     WHERE m.empresa_id = ${c.u.empresaId}
       AND (a.disparado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${de} AND ${ate}
       ${dimensoesSilver(sql, c)}
       ${refinamentos(sql, c, { veiculo: "a.veiculo_id", hora: "a.disparado_em" })}
  `;
}

function turnosFiltrados(sql: Sql, c: Contexto) {
  return sql`
    SELECT t.*, m.codigo, m.nome_exibicao AS motorista, v.placa, v.tipo::text AS tipo_veiculo
      FROM silver.turnos t
      JOIN silver.motoristas m ON m.id = t.motorista_id
      LEFT JOIN silver.dim_uf uf ON uf.uf = m.regiao_uf
      LEFT JOIN silver.veiculos v ON v.id = t.veiculo_id
     WHERE m.empresa_id = ${c.u.empresaId}
       AND (t.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${c.f.periodo.de} AND ${c.f.periodo.ate}
       ${dimensoesSilver(sql, c)}
       ${refinamentos(sql, c, { veiculo: "t.veiculo_id", hora: "t.iniciado_em" })}
  `;
}

/** Série diária de fadiga: Gold quando dá, Silver quando há filtro de veículo ou risco. */
async function serieFadiga(sql: Sql, c: Contexto) {
  let linhas: { dia: string; fadiga: number | null }[];
  if (c.r.veiculo_id || c.r.risco) {
    linhas = await sql<{ dia: string; fadiga: number | null }[]>`
      SELECT (l.registrado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia, ROUND(AVG(l.score_fadiga), 1) AS fadiga
        FROM silver.leituras_fadiga l
        JOIN silver.motoristas m ON m.id = l.motorista_id
        LEFT JOIN silver.dim_uf uf ON uf.uf = m.regiao_uf
        LEFT JOIN silver.veiculos v ON v.id = l.veiculo_id
       WHERE m.empresa_id = ${c.u.empresaId}
         AND l.registrado_em >= (${c.f.periodo.de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
         AND l.registrado_em <  ((${c.f.periodo.ate}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
         ${dimensoesSilver(sql, c)}
         ${refinamentos(sql, c, { veiculo: "l.veiculo_id" })}
       GROUP BY 1 ORDER BY 1
    `;
  } else {
    linhas = (await dashboard.evolucaoFadiga(c.u, c.f)).serie.map((s) => ({ dia: s.dia, fadiga: s.fadiga }));
  }
  const porDia = new Map(linhas.map((l) => [l.dia, l.fadiga]));
  return listaDias(c.f.periodo.de, c.f.periodo.ate).map((dia) => ({ dia, rotulo: formatarDiaBr(dia), fadiga: porDia.get(dia) ?? null }));
}

function descreverFiltros(c: Contexto): string {
  const p = c.f.periodo;
  const partes = [`${formatarDiaBr(p.de)}/${p.de.slice(0, 4)} a ${formatarDiaBr(p.ate)}/${p.ate.slice(0, 4)}`];
  if (c.f.regiao) partes.push(c.f.regiao.valor);
  if (c.f.tipoVeiculo) partes.push(ROTULO_TIPO_VEICULO[c.f.tipoVeiculo]);
  if (c.r.risco) partes.push(`motoristas de risco ${c.r.risco}`);
  if (c.r.faixa_horaria) partes.push(`alertas da ${ROTULO_FAIXA[c.r.faixa_horaria]}`);
  return partes.join(" • ");
}

// ---------------------------------------------------------------------------
// Aba Relatórios
// ---------------------------------------------------------------------------

export async function resumo(c: Contexto) {
  const sql = db();
  const [[contagens], [anterior], [frota], serie, distribuicao, calc, kpis] = await Promise.all([
    sql`SELECT COUNT(*)::int AS eventos, COUNT(*) FILTER (WHERE gravidade IN ('alta', 'critica'))::int AS graves,
               COUNT(*) FILTER (WHERE atendido AND gravidade IN ('alta', 'critica'))::int AS atendidos
          FROM (${alertasFiltrados(sql, c)}) x`,
    sql`SELECT COUNT(*)::int AS eventos FROM (${alertasFiltrados(sql, c, c.f.periodo.anteriorDe, c.f.periodo.anteriorAte)}) x`,
    sql`SELECT COUNT(DISTINCT motorista_id)::int AS motoristas, COUNT(DISTINCT veiculo_id)::int AS veiculos,
               COUNT(*)::int AS turnos, ROUND(COALESCE(SUM(duracao_minutos), 0) / 60.0, 1) AS horas
          FROM (${turnosFiltrados(sql, c)}) x`,
    serieFadiga(sql, c),
    sql<{ tipo: string; eventos: number }[]>`SELECT tipo::text AS tipo, COUNT(*)::int AS eventos FROM (${alertasFiltrados(sql, c)}) x GROUP BY 1 ORDER BY 2 DESC`,
    roi.calcular(c.u.empresaId),
    dashboard.kpis(c.u, c.f),
  ]);

  const economia = calc.disponivel ? Math.round((calc.cenarios.conservador.custoEvitado * c.f.periodo.dias) / 365) : null;
  const fadigas = serie.map((s) => s.fadiga).filter((x): x is number => x !== null);

  return {
    periodo: c.f.periodo,
    filtros: descreverFiltros(c),
    kpis: {
      eventos: contagens.eventos,
      eventosAnterior: anterior.eventos,
      variacaoEventos: variacaoPercentual(contagens.eventos, anterior.eventos),
      alertasGraves: contagens.graves,
      // Graves atendidos: o percentual é o indicador, o número é o detalhe.
      alertasAtendidos: contagens.atendidos,
      percentualAtendidos: contagens.graves ? arred((contagens.atendidos / contagens.graves) * 100, 0) : null,
      motoristasAnalisados: frota.motoristas,
      veiculosAnalisados: frota.veiculos,
      turnos: frota.turnos,
      horasDirigidas: frota.horas,
      fadigaMedia: fadigas.length ? arred(fadigas.reduce((a, b) => a + b, 0) / fadigas.length, 1) : null,
      economiaEstimada: economia,
      economiaDisponivel: calc.disponivel,
    },
    serieFadiga: serie,
    distribuicaoAlertas: distribuicao.map((d) => ({ tipo: d.tipo, rotulo: dashboard.ROTULO_ALERTA[d.tipo] ?? d.tipo, eventos: d.eventos })),
    resumoInteligente: await resumoInteligente(c, kpis, distribuicao),
  };
}

/** Resumo em frases. Sem outros filtros, usa o da IA para o mesmo período, se houver rodada recente. */
async function resumoInteligente(c: Contexto, kpis: Awaited<ReturnType<typeof dashboard.kpis>>, distribuicao: { tipo: string; eventos: number }[]) {
  const semRefino = !c.r.risco && !c.r.veiculo_id && !c.r.faixa_horaria && !c.f.regiao && !c.f.tipoVeiculo;
  if (semRefino) {
    const ultimos = await insights.ultimos(c.u.empresaId, { de: c.f.periodo.de, ate: c.f.periodo.ate });
    if (ultimos.origem === "ia" && ultimos.resumo.length) {
      return { frases: ultimos.resumo, origem: "ia", geradoEm: ultimos.geradoEm };
    }
  }

  const frases: string[] = [];
  const p = kpis.periodo;
  if (p.variacaoFadiga !== null && Math.abs(p.variacaoFadiga) < 1) {
    frases.push(`A fadiga média ficou estável em relação ao período anterior (${formatarNumero(p.fadigaMedia, 1)} contra ${formatarNumero(p.fadigaMediaAnterior, 1)}).`);
  } else if (p.variacaoFadiga !== null) {
    frases.push(`A fadiga média ${p.variacaoFadiga <= 0 ? "reduziu" : "aumentou"} ${Math.abs(p.variacaoFadiga)}% em relação ao período anterior (${formatarNumero(p.fadigaMedia, 1)} contra ${formatarNumero(p.fadigaMediaAnterior, 1)}).`);
  } else if (p.fadigaMedia !== null) {
    frases.push(`A fadiga média da frota no período foi de ${formatarNumero(p.fadigaMedia, 1)}.`);
  }
  if (kpis.horarioCritico) {
    frases.push(`A maior concentração de alertas ocorreu entre ${kpis.horarioCritico.inicio} e ${kpis.horarioCritico.fim} (${kpis.horarioCritico.percentual}% do total).`);
  }
  if (distribuicao[0]) {
    frases.push(`O sinal mais frequente foi ${(dashboard.ROTULO_ALERTA[distribuicao[0].tipo] ?? distribuicao[0].tipo).toLowerCase()}, com ${distribuicao[0].eventos} alertas.`);
  }
  const rotas = await dashboard.rotas(c.u, c.f);
  const rota = [...rotas].sort((a, b) => (b.eventos as number) - (a.eventos as number))[0];
  if (rota && (rota.eventos as number) > 0) frases.push(`A rota ${rota.origemCidade} → ${rota.destinoCidade} concentrou o maior número de alertas (${rota.eventos}).`);
  frases.push("Pausas preventivas antes do horário crítico e da 6ª hora de direção são a medida com maior efeito sobre os riscos operacionais.");
  return { frases, origem: "regras", geradoEm: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Documentos por tipo
// ---------------------------------------------------------------------------

async function nomeEmpresa(empresaId: string) {
  const sql = db();
  const [e] = await sql`SELECT COALESCE(nome_fantasia, razao_social) AS nome FROM silver.empresas WHERE id = ${empresaId}`;
  return (e?.nome as string) ?? "Empresa";
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2025-12" -> "dez/2025". */
export const mesAno = (aaaaMm: string) => `${MESES[Number(aaaaMm.slice(5, 7)) - 1]}/${aaaaMm.slice(0, 4)}`;

function valorParametro(valor: number, unidade: string): string {
  if (unidade === "R$") return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const n = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
  if (unidade === "fração") return `${n(valor * 100)}%`;
  if (unidade === "fator") return n(valor);
  return `${n(valor)} ${unidade}`;
}

const fmtHora = (d: unknown) =>
  d ? new Date(d as Date).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;

async function executivo(c: Contexto): Promise<Secao[]> {
  const [res, kpis, rotas, ranking, calc, prf] = await Promise.all([
    resumo(c),
    dashboard.kpis(c.u, c.f),
    dashboard.rotas(c.u, c.f),
    rankingMotoristas(c, 10),
    roi.calcular(c.u.empresaId),
    dashboard.prfResumo(c.f, {}),
  ]);
  const p = kpis.periodo;
  const variacao = (v: number | null) => (v === null ? "sem base anterior" : `${v >= 0 ? "+" : ""}${v}% vs período anterior`);

  const secoes: Secao[] = [
    {
      titulo: "Indicadores do período",
      kpis: [
        { rotulo: "Fadiga média", valor: formatarNumero(p.fadigaMedia, 1), detalhe: variacao(p.variacaoFadiga) },
        { rotulo: "Alertas", valor: formatarNumero(p.alertas), detalhe: variacao(p.variacaoAlertas) },
        { rotulo: "Alertas graves", valor: formatarNumero(p.alertasGraves) },
        {
          rotulo: "Graves atendidos",
          valor: res.kpis.percentualAtendidos !== null ? `${formatarNumero(res.kpis.percentualAtendidos)}%` : "—",
          detalhe: `${formatarNumero(res.kpis.alertasAtendidos)} de ${formatarNumero(res.kpis.alertasGraves)} graves`,
        },
        { rotulo: "Motoristas analisados", valor: formatarNumero(res.kpis.motoristasAnalisados) },
        { rotulo: "Veículos analisados", valor: formatarNumero(res.kpis.veiculosAnalisados) },
        { rotulo: "Horas dirigidas", valor: formatarNumero(p.horasDirigidas, 0) },
        { rotulo: "Economia estimada", valor: formatarReais(res.kpis.economiaEstimada), detalhe: "cenário conservador, no período" },
      ],
      texto: kpis.horarioCritico
        ? [`Horário crítico: ${kpis.horarioCritico.inicio} às ${kpis.horarioCritico.fim}, com ${kpis.horarioCritico.percentual}% dos alertas (${kpis.horarioCritico.madrugadaPercentual}% entre 0h e 6h).`]
        : [],
    },
    { titulo: "Resumo inteligente", texto: res.resumoInteligente.frases },
    {
      titulo: "Rotas com maior incidência",
      tabela: {
        aba: "Rotas",
        colunas: [{ titulo: "Rota", largura: 3 }, { titulo: "Fadiga", numero: true }, { titulo: "Alertas", numero: true }, { titulo: "Tendência", numero: true }, { titulo: "Acid. por sono (PRF 12m)", largura: 1.6, numero: true }],
        linhas: rotas.slice(0, 8).map((r) => [`${r.origemCidade} → ${r.destinoCidade}`, r.fadiga as number | null, r.eventos as number, r.tendencia === null ? null : `${r.tendencia > 0 ? "+" : ""}${r.tendencia}%`, r.prf?.acidentesSono ?? null]),
      },
    },
    {
      titulo: "Motoristas em maior risco (30 dias)",
      tabela: {
        aba: "Motoristas em risco",
        colunas: [{ titulo: "Código" }, { titulo: "Motorista", largura: 2 }, { titulo: "Fadiga média", numero: true }, { titulo: "Alertas graves", numero: true }, { titulo: "Horas", numero: true }, { titulo: "Risco" }],
        linhas: ranking.map((m) => [m.codigo, m.motorista, m.fadiga, m.graves, m.horas, m.risco]),
      },
    },
  ];

  if (calc.disponivel) {
    const cons = calc.cenarios.conservador;
    const real = calc.cenarios.realista;
    secoes.push({
      titulo: "Impacto estimado (ROI, por ano)",
      kpis: [
        { rotulo: "Menos acidentes por sono", valor: `${calc.reducaoAcidentesSonoPercentual}%`, detalhe: `cobertura de ${formatarNumero((calc.cobertura.fracao ?? 0) * 100, 0)}% da frota` },
        { rotulo: "Acidentes evitados", valor: `${formatarNumero(cons.acidentesEvitados, 2)} a ${formatarNumero(real.acidentesEvitados, 2)}`, detalhe: "conservador a realista" },
        { rotulo: "Custo evitado", valor: formatarReais(cons.custoEvitado), detalhe: `até ${formatarReais(real.custoEvitado)} no realista` },
        { rotulo: "Vidas preservadas", valor: `${formatarNumero(cons.vidasPreservadas, 2)} a ${formatarNumero(real.vidasPreservadas, 2)}` },
      ],
      texto: [
        calc.nota,
        `Custo médio por acidente: ${formatarReais(calc.custoMedioPorAcidente)} (gravidade: ${calc.proporcoesGravidade.fonte}).`,
        ...calc.parametros
          // Com a PRF carregada, os padrões de gravidade e letalidade não entram na conta.
          .filter((x) => x.valor !== null && !(x.chave.endsWith("_padrao") && calc.proporcoesGravidade.fonte.startsWith("PRF")))
          .map((x) => `${x.descricao.split(".")[0]}: ${valorParametro(x.valor!, x.unidade)} (${x.fonte ?? "sem fonte"}${x.referencia ? `, ${x.referencia}` : ""})`),
      ],
    });
  } else {
    secoes.push({ titulo: "Impacto estimado (ROI)", texto: ["ROI não calculado: " + calc.pendencias.join(" ")] });
  }

  if (prf.carregada && "acidentes" in prf) {
    secoes.push({
      titulo: "Base comparativa nacional (Fonte: PRF)",
      texto: [
        `Nos 12 meses até ${mesAno(prf.janela!.ate)}, as rodovias federais registraram ${formatarNumero(prf.acidentes)} acidentes com veículos pesados, ${formatarNumero(prf.acidentesSono)} (${formatarNumero(prf.percentualSono, 1)}%) com condutor dormindo e ${formatarNumero(prf.mortos)} mortes.`,
        `${prf.fonte}. Os números da PRF são referência nacional, não dados da frota.`,
      ],
    });
  }
  return secoes;
}

async function rankingMotoristas(c: Contexto, limite?: number) {
  const sql = db();
  const linhas = await sql`
    SELECT codigo, motorista, regiao_uf, tipo_veiculo, placa, veiculo_codigo, score_fadiga_medio, score_fadiga_maximo,
           alertas_30d, alertas_graves_30d, horas_dirigidas_30d, turnos_30d, nivel_risco, posicao_risco
      FROM gold.mv_ranking_motoristas
     WHERE empresa_id = ${c.u.empresaId} ${condicoesDimensao(sql, c.f)}
       ${c.r.risco ? sql`AND nivel_risco = ${RISCO_PARA_NIVEL[c.r.risco]}` : sql``}
     ORDER BY posicao_risco
     ${limite ? sql`LIMIT ${limite}` : sql``}
  `;
  return linhas.map((l) => ({
    codigo: (l.codigo as string) ?? "—",
    motorista: l.motorista as string,
    regiao: l.regiao_uf as string,
    veiculo: ROTULO_TIPO_VEICULO[l.tipo_veiculo as string] ?? (l.tipo_veiculo as string),
    placa: l.placa as string | null,
    camera: l.veiculo_codigo as string | null,
    fadiga: arred(l.score_fadiga_medio as number | null, 1),
    maximo: arred(l.score_fadiga_maximo as number | null, 1),
    alertas: l.alertas_30d as number,
    graves: l.alertas_graves_30d as number,
    horas: arred(l.horas_dirigidas_30d as number | null, 1),
    turnos: l.turnos_30d as number,
    risco: ROTULO_RISCO[l.nivel_risco as string] ?? (l.nivel_risco as string),
    posicao: l.posicao_risco as number,
  }));
}

async function operacional(c: Contexto): Promise<Secao[]> {
  const sql = db();
  const [diario, turnos, distribuicao] = await Promise.all([
    sql`
      SELECT dia::text AS dia, ROUND(SUM(soma_score) / NULLIF(SUM(total_leituras), 0), 1) AS fadiga,
             SUM(total_leituras)::int AS leituras, SUM(total_alertas)::int AS alertas, SUM(alertas_graves)::int AS graves,
             SUM(total_turnos)::int AS turnos, ROUND(SUM(soma_minutos_turno) / 60.0, 1) AS horas, ROUND(SUM(distancia_total_km), 0) AS km
        FROM gold.mv_kpis_diarios
       WHERE empresa_id = ${c.u.empresaId} AND dia BETWEEN ${c.f.periodo.de} AND ${c.f.periodo.ate} ${condicoesDimensao(sql, c.f)}
       GROUP BY dia ORDER BY dia
    `,
    sql`
      SELECT t.iniciado_em, t.finalizado_em, t.codigo, t.placa, t.tipo_veiculo, t.origem_cidade, t.destino_cidade,
             ROUND(t.duracao_minutos / 60.0, 1) AS horas, t.status::text AS status,
             (SELECT ROUND(SUM(cf.soma_score) / NULLIF(SUM(cf.leituras), 0), 1) FROM gold.mv_curva_fadiga_turno cf WHERE cf.turno_id = t.id) AS fadiga,
             (SELECT COUNT(*)::int FROM silver.alertas a WHERE a.turno_id = t.id) AS alertas
        FROM (${turnosFiltrados(sql, c)}) t
       ORDER BY t.iniciado_em DESC
       LIMIT 2000
    `,
    sql`SELECT tipo::text AS tipo, gravidade::text AS gravidade, COUNT(*)::int AS total
          FROM (${alertasFiltrados(sql, c)}) x GROUP BY 1, 2 ORDER BY 3 DESC`,
  ]);

  return [
    {
      titulo: "Indicadores diários",
      tabela: {
        aba: "Diário",
        colunas: [{ titulo: "Dia" }, { titulo: "Fadiga média", numero: true }, { titulo: "Leituras", numero: true }, { titulo: "Alertas", numero: true }, { titulo: "Graves", numero: true }, { titulo: "Turnos", numero: true }, { titulo: "Horas", numero: true }, { titulo: "Km", numero: true }],
        linhas: diario.map((d) => [formatarDiaBr(d.dia as string), d.fadiga as number | null, d.leituras as number, d.alertas as number, d.graves as number, d.turnos as number, d.horas as number, d.km as number]),
      },
    },
    {
      titulo: "Turnos",
      tabela: {
        aba: "Turnos",
        colunas: [{ titulo: "Início" }, { titulo: "Fim" }, { titulo: "Motorista" }, { titulo: "Veículo" }, { titulo: "Rota", largura: 2.4 }, { titulo: "Horas", numero: true }, { titulo: "Fadiga", numero: true }, { titulo: "Alertas", numero: true }],
        linhas: turnos.map((t) => [
          fmtHora(t.iniciado_em),
          fmtHora(t.finalizado_em) ?? "em andamento",
          (t.codigo as string) ?? "—",
          (t.placa as string) ?? ROTULO_TIPO_VEICULO[t.tipo_veiculo as string] ?? "—",
          t.origem_cidade ? `${t.origem_cidade} → ${t.destino_cidade}` : "sem viagem cadastrada",
          t.horas as number | null,
          t.fadiga as number | null,
          t.alertas as number,
        ]),
      },
    },
    {
      titulo: "Alertas por tipo e gravidade",
      tabela: {
        aba: "Alertas por tipo",
        colunas: [{ titulo: "Tipo", largura: 2 }, { titulo: "Gravidade" }, { titulo: "Alertas", numero: true }],
        linhas: distribuicao.map((d) => [dashboard.ROTULO_ALERTA[d.tipo as string] ?? (d.tipo as string), d.gravidade as string, d.total as number]),
      },
    },
  ];
}

async function motoristas(c: Contexto): Promise<Secao[]> {
  const ranking = await rankingMotoristas(c);
  return [
    {
      titulo: "Indicadores por motorista (últimos 30 dias)",
      texto: ["Métricas de 30 dias corridos até hoje, independentemente do período escolhido."],
      tabela: {
        aba: "Motoristas",
        colunas: [{ titulo: "#", numero: true, largura: 0.5 }, { titulo: "Código" }, { titulo: "Motorista", largura: 2 }, { titulo: "UF", largura: 0.6 }, { titulo: "Veículo" }, { titulo: "Fadiga média", numero: true }, { titulo: "Máx.", numero: true }, { titulo: "Alertas", numero: true }, { titulo: "Graves", numero: true }, { titulo: "Horas", numero: true }, { titulo: "Risco" }],
        linhas: ranking.map((m) => [m.posicao, m.codigo, m.motorista, m.regiao, m.camera ?? m.veiculo, m.fadiga, m.maximo, m.alertas, m.graves, m.horas, m.risco]),
      },
    },
  ];
}

async function frota(c: Contexto): Promise<Secao[]> {
  const sql = db();
  const [linhas, calc] = await Promise.all([
    sql`
      WITH periodo AS (
          SELECT t.veiculo_id, COUNT(*)::int AS turnos, ROUND(COALESCE(SUM(t.duracao_minutos), 0) / 60.0, 1) AS horas,
                 SUM((SELECT COUNT(*) FROM silver.alertas a WHERE a.turno_id = t.id))::int AS alertas,
                 ROUND(SUM(cf.soma) / NULLIF(SUM(cf.leituras), 0), 1) AS fadiga
            FROM (${turnosFiltrados(sql, c)}) t
            LEFT JOIN LATERAL (SELECT SUM(soma_score) AS soma, SUM(leituras) AS leituras FROM gold.mv_curva_fadiga_turno WHERE turno_id = t.id) cf ON TRUE
           GROUP BY t.veiculo_id
      )
      SELECT v.placa, v.tipo::text AS tipo, v.modelo, v.ativo, d.codigo AS camera, d.status::text AS status_camera,
             d.ultimo_contato_em, p.turnos, p.horas, p.alertas, p.fadiga
        FROM silver.veiculos v
        LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.veiculo_id = v.id AND vd.fim IS NULL
        LEFT JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
        LEFT JOIN periodo p ON p.veiculo_id = v.id
       WHERE v.empresa_id = ${c.u.empresaId}
         ${c.f.tipoVeiculo ? sql`AND v.tipo = ${c.f.tipoVeiculo}::silver.tipo_veiculo` : sql``}
         ${c.r.veiculo_id ? sql`AND v.id = ${c.r.veiculo_id}` : sql``}
       ORDER BY p.alertas DESC NULLS LAST, v.placa
    `,
    roi.calcular(c.u.empresaId),
  ]);
  return [
    {
      titulo: "Cobertura",
      kpis: [
        { rotulo: "Veículos cadastrados", valor: formatarNumero(linhas.length) },
        { rotulo: "Com câmera ativa", valor: formatarNumero(calc.cobertura.veiculosComCamera) },
        { rotulo: "Frota total", valor: formatarNumero(calc.cobertura.frotaTotal), detalhe: calc.cobertura.frotaInformada ? "informada pela empresa" : "veículos cadastrados" },
        { rotulo: "Cobertura", valor: `${formatarNumero((calc.cobertura.fracao ?? 0) * 100, 0)}%` },
      ],
    },
    {
      titulo: "Veículos no período",
      tabela: {
        aba: "Veículos",
        colunas: [{ titulo: "Câmera" }, { titulo: "Placa" }, { titulo: "Tipo" }, { titulo: "Modelo", largura: 1.4 }, { titulo: "Câmera status" }, { titulo: "Último contato", largura: 1.2 }, { titulo: "Turnos", numero: true }, { titulo: "Horas", numero: true }, { titulo: "Alertas", numero: true }, { titulo: "Fadiga", numero: true }],
        linhas: linhas.map((v) => [
          (v.camera as string) ?? "sem câmera",
          (v.placa as string) ?? "—",
          ROTULO_TIPO_VEICULO[v.tipo as string] ?? (v.tipo as string),
          (v.modelo as string) ?? "—",
          (v.status_camera as string) ?? "—",
          fmtHora(v.ultimo_contato_em),
          (v.turnos as number) ?? 0,
          (v.horas as number) ?? 0,
          (v.alertas as number) ?? 0,
          v.fadiga as number | null,
        ]),
      },
    },
  ];
}

async function alertas(c: Contexto): Promise<Secao[]> {
  const sql = db();
  const linhas = await sql`
    SELECT disparado_em, codigo, motorista, placa, tipo_veiculo, tipo::text AS tipo, gravidade::text AS gravidade,
           status::text AS status, score_fadiga, atendido
      FROM (${alertasFiltrados(sql, c)}) x
     ORDER BY disparado_em DESC
     LIMIT 20000
  `;
  return [
    {
      titulo: "Alertas registrados",
      tabela: {
        aba: "Alertas",
        colunas: [{ titulo: "Data/hora", largura: 1.2 }, { titulo: "Código" }, { titulo: "Motorista", largura: 1.8 }, { titulo: "Veículo" }, { titulo: "Tipo", largura: 1.6 }, { titulo: "Gravidade" }, { titulo: "Status" }, { titulo: "Score", numero: true }, { titulo: "Atendido" }],
        linhas: linhas.map((a) => [
          fmtHora(a.disparado_em),
          (a.codigo as string) ?? "—",
          a.motorista as string,
          (a.placa as string) ?? ROTULO_TIPO_VEICULO[a.tipo_veiculo as string] ?? "—",
          dashboard.ROTULO_ALERTA[a.tipo as string] ?? (a.tipo as string),
          a.gravidade as string,
          a.status as string,
          a.score_fadiga as number | null,
          a.atendido ? "sim" : "não",
        ]),
      },
    },
  ];
}

const MONTADORES: Record<TipoRelatorio, (c: Contexto) => Promise<Secao[]>> = { executivo, operacional, motoristas, frota, alertas };

export async function documento(c: Contexto, tipo: TipoRelatorio): Promise<Documento> {
  const [secoes, empresa] = await Promise.all([MONTADORES[tipo](c), nomeEmpresa(c.u.empresaId)]);
  return { titulo: TITULO_RELATORIO[tipo], subtitulo: descreverFiltros(c), empresa, geradoEm: new Date(), secoes };
}
