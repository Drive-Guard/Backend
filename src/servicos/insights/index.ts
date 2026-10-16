/**
 * Orquestração dos insights:
 *
 *   pedir()   (VPC: API ou agendamento horário)
 *       grava insights/contextos/<empresa>/<execucao>.json e a execução pendente
 *   insightsIa (fora da VPC)          -> insights/respostas/<empresa>/<execucao>.json
 *   gravar()  (VPC)                   -> silver.insights_frota / insights_motorista
 */

import { randomUUID } from "node:crypto";
import { gravarJson } from "../../lib/arquivos";
import { db } from "../../lib/db";
import { chavePeriodo, filtrosDoPeriodo, montarContexto, rotuloPeriodo, type ConsultaPeriodo } from "./contexto";
import { gerarPorRegras } from "./regras";
import type { RespostaInsights } from "./tipos";

export const chaveContexto = (empresaId: string, execucaoId: string) => `insights/contextos/${empresaId}/${execucaoId}.json`;
export const chaveResposta = (empresaId: string, execucaoId: string) => `insights/respostas/${empresaId}/${execucaoId}.json`;

/** Validade de uma rodada: depois disso a dashboard mostra que está desatualizada. */
const VALIDADE_HORAS = 24;

/** Pede uma rodada de insights para o período (o filtro da dashboard; padrão 30 dias). */
export async function pedir(empresaId: string, consulta: ConsultaPeriodo = {}) {
  const sql = db();
  const execucaoId = randomUUID();
  const contexto = await montarContexto(empresaId, execucaoId, consulta);
  const chave = chaveContexto(empresaId, execucaoId);
  const periodo = chavePeriodo(contexto.periodo);
  await sql`
    INSERT INTO silver.insights_execucoes (id, empresa_id, versao_prompt, status, contexto_s3_key, periodo)
    VALUES (${execucaoId}, ${empresaId}, 'contexto-v2', 'pendente', ${chave}, ${periodo})
  `;
  await gravarJson(chave, contexto);
  return { execucaoId, status: "pendente" as const, periodo: contexto.periodo };
}

/** Empresas com leitura nos últimos 7 dias: as que recebem a rodada horária. */
export async function empresasAtivas(): Promise<string[]> {
  const sql = db();
  const linhas = await sql`
    SELECT DISTINCT m.empresa_id
      FROM silver.leituras_fadiga l JOIN silver.motoristas m ON m.id = l.motorista_id
     WHERE l.registrado_em >= now() - interval '7 days'
  `;
  return linhas.map((l) => l.empresa_id as string);
}

const PARA_GRAVIDADE: Record<string, string> = { baixa: "baixa", media: "media", alta: "alta", critica: "critica" };

export async function gravar(r: RespostaInsights) {
  const sql = db();
  const origem = r.status === "ok" ? "modelo" : "regra";

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO silver.insights_execucoes (id, empresa_id, status)
      VALUES (${r.execucaoId}, ${r.empresaId}, 'pendente')
      ON CONFLICT (id) DO NOTHING
    `;
    for (const rec of r.recomendacoes) {
      await tx`
        INSERT INTO silver.insights_frota (empresa_id, titulo, descricao, severidade, acao_sugerida, metrica_referencia,
                                           origem, valido_ate, categoria, execucao_id)
        VALUES (${r.empresaId}, ${rec.titulo}, ${rec.descricao}, ${PARA_GRAVIDADE[rec.severidade]}::silver.gravidade,
                ${rec.acao_sugerida}, ${tx.json({ metrica: rec.metrica })}, ${origem}::silver.origem_insight,
                now() + make_interval(hours => ${VALIDADE_HORAS}), 'recomendacao', ${r.execucaoId})
      `;
    }
    await tx`
      INSERT INTO silver.insights_frota (empresa_id, titulo, descricao, severidade, origem, valido_ate, categoria, execucao_id)
      VALUES (${r.empresaId}, 'Resumo inteligente', ${r.resumo.join("\n")}, 'baixa', ${origem}::silver.origem_insight,
              now() + make_interval(hours => ${VALIDADE_HORAS}), 'resumo', ${r.execucaoId})
    `;
    for (const m of r.motoristas) {
      await tx`
        INSERT INTO silver.insights_motorista (motorista_id, titulo, descricao, severidade, origem, valido_ate, execucao_id)
        SELECT id, ${m.titulo}, ${m.descricao}, ${PARA_GRAVIDADE[m.severidade]}::silver.gravidade, ${origem}::silver.origem_insight,
               now() + make_interval(hours => ${VALIDADE_HORAS}), ${r.execucaoId}
          FROM silver.motoristas WHERE empresa_id = ${r.empresaId} AND codigo = ${m.codigo}
      `;
    }
    await tx`
      UPDATE silver.insights_execucoes
         SET concluido_em = now(), status = ${r.status}, provedor = ${r.provedor}, modelo = ${r.modelo},
             versao_prompt = ${r.versaoPrompt}, tokens_entrada = ${r.tokensEntrada}, tokens_saida = ${r.tokensSaida},
             erro = ${r.erro}
       WHERE id = ${r.execucaoId}
    `;
  });
}

const DE_GRAVIDADE: Record<string, string> = { baixa: "low", media: "medium", alta: "high", critica: "critical" };

/**
 * Insights mais recentes da empresa para o período (o filtro da dashboard).
 * Usa a última rodada válida daquele período (dentro da validade); sem
 * nenhuma, calcula pelas regras na hora, sem gravar.
 */
export async function ultimos(empresaId: string, consulta: ConsultaPeriodo = {}) {
  const sql = db();
  const f = filtrosDoPeriodo(consulta);
  const periodo = chavePeriodo(f.periodo);
  const infoPeriodo = { de: f.periodo.de, ate: f.periodo.ate, dias: f.periodo.dias, rotulo: rotuloPeriodo(f.periodo) };
  const [exec] = await sql`
    SELECT e.id, e.concluido_em, e.status, e.provedor, e.modelo
      FROM silver.insights_execucoes e
     WHERE e.empresa_id = ${empresaId} AND e.periodo = ${periodo} AND e.status IN ('ok', 'fallback_regras')
       AND e.concluido_em >= now() - make_interval(hours => ${VALIDADE_HORAS})
       AND EXISTS (SELECT 1 FROM silver.insights_frota f WHERE f.execucao_id = e.id)
     ORDER BY e.concluido_em DESC NULLS LAST LIMIT 1
  `;
  const [pendente] = await sql`
    SELECT id, iniciado_em FROM silver.insights_execucoes
     WHERE empresa_id = ${empresaId} AND periodo = ${periodo} AND status = 'pendente'
       AND iniciado_em >= now() - interval '10 minutes'
     ORDER BY iniciado_em DESC LIMIT 1
  `;

  if (exec) {
    const linhas = await sql`
      SELECT id, titulo, descricao, severidade::text AS severidade, acao_sugerida, origem::text AS origem,
             categoria, gerado_em, valido_ate
        FROM silver.insights_frota WHERE execucao_id = ${exec.id}
       ORDER BY CASE severidade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, gerado_em
    `;
    return {
      execucaoId: exec.id,
      periodo: infoPeriodo,
      geradoEm: exec.concluido_em,
      provedor: exec.provedor,
      modelo: exec.modelo,
      origem: exec.status === "ok" ? "ia" : "regras",
      atualizando: !!pendente,
      recomendacoes: linhas
        .filter((l) => l.categoria === "recomendacao")
        .map((l) => ({ id: l.id, titulo: l.titulo, descricao: l.descricao, severidade: DE_GRAVIDADE[l.severidade as string], acao: l.acao_sugerida, origem: l.origem })),
      resumo: ((linhas.find((l) => l.categoria === "resumo")?.descricao as string) ?? "").split("\n").filter(Boolean),
    };
  }

  const regras = gerarPorRegras(await montarContexto(empresaId, undefined, consulta));
  return {
    execucaoId: null,
    periodo: infoPeriodo,
    geradoEm: new Date().toISOString(),
    provedor: "regras",
    modelo: null,
    origem: "regras",
    atualizando: !!pendente,
    recomendacoes: regras.recomendacoes.map((r, i) => ({ id: `regra-${i}`, titulo: r.titulo, descricao: r.descricao, severidade: DE_GRAVIDADE[r.severidade], acao: r.acao_sugerida, origem: "regra" })),
    resumo: regras.resumo,
  };
}
