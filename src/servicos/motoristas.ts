/**
 * Aba Motoristas: lista ao vivo, detalhe, curva do turno, insights e ações.
 */

import { z } from "zod";
import { autor, type Usuario } from "../lib/auth";
import { db } from "../lib/db";
import { condicoesDimensao, type Filtros, ROTULO_TIPO_VEICULO } from "../lib/filtros";
import { conflito, naoEncontrado } from "../lib/http";
import { formatarNumero, nivelRisco } from "../lib/numeros";
import { desfazerResposta } from "./alertas";
import { ACOES_QUE_ATENDEM, JANELA_AO_VIVO, MINUTOS_PARA_DESFAZER, ROTULO_ALERTA } from "./dashboard";

async function garantirDaEmpresa(u: Usuario, motoristaId: string) {
  const sql = db();
  const [m] = await sql`SELECT id FROM silver.motoristas WHERE id = ${motoristaId} AND empresa_id = ${u.empresaId}`;
  if (!m) throw naoEncontrado("Motorista");
}

const uuid = z.string().uuid("id inválido");

export async function aoVivo(u: Usuario, f: Filtros) {
  const sql = db();
  // Ocorrências da frota no período e a rota do turno mais recente: base dos
  // filtros que as outras telas aplicam ao abrir esta (ver ?filtro= no front).
  const linhas = await sql`
    SELECT f.*, f.ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval AS ativo,
           r.score_fadiga_medio AS score_medio_30d,
           (SELECT COUNT(*) FROM silver.incidentes i
             WHERE i.motorista_id = f.motorista_id AND i.origem = 'interno'
               AND (i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate})::int AS ocorrencias,
           (SELECT COUNT(*) FROM silver.incidentes i
             WHERE i.motorista_id = f.motorista_id AND i.origem = 'interno' AND i.relacionado_sonolencia
               AND (i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate})::int AS ocorrencias_sono,
           (SELECT t.origem_cidade || ' → ' || t.destino_cidade FROM silver.turnos t
             WHERE t.motorista_id = f.motorista_id AND t.origem_cidade IS NOT NULL
             ORDER BY t.iniciado_em DESC LIMIT 1) AS rota
      FROM gold.vw_frota_agora f
      LEFT JOIN gold.mv_ranking_motoristas r ON r.motorista_id = f.motorista_id
     WHERE f.empresa_id = ${u.empresaId} ${condicoesDimensao(sql, f, "f")}
     ORDER BY ativo DESC, f.score_atual DESC
  `;
  return linhas.map((m) => ({
    motoristaId: m.motorista_id,
    codigo: m.codigo,
    nome: m.nome,
    idade: m.idade,
    anosExperiencia: m.anos_experiencia,
    regiao: m.regiao_uf,
    macroRegiao: m.macro_regiao,
    tipoVeiculo: ROTULO_TIPO_VEICULO[m.tipo_veiculo as string] ?? m.tipo_veiculo,
    placa: m.placa,
    veiculoCodigo: m.veiculo_codigo,
    horasTurno: m.horas_turno,
    turnoStatus: m.turno_status,
    score: m.score_atual,
    risco: m.risco,
    // Tendência: última leitura contra a média das 5 anteriores (±1 ponto).
    tendencia: m.tendencia,
    scoreAnterior: m.score_medio_anterior as number | null,
    blinkRate: m.blink_rate,
    fechamentoOlhosMs: m.duracao_olhos_fechados_ms,
    inclinacaoCabeca: m.head_pitch !== null ? Math.abs(m.head_pitch as number) : null,
    perclos: m.perclos,
    alertasHoje: m.alertas_hoje,
    ultimaLeituraEm: m.ultima_leitura_em,
    ativo: m.ativo,
    scoreMedio30d: m.score_medio_30d,
    ocorrencias: m.ocorrencias as number,
    ocorrenciasSono: m.ocorrencias_sono as number,
    rota: m.rota as string | null,
  }));
}

/**
 * Turnos de um intervalo passado, por motorista: a lista da aba Motoristas
 * quando o gestor escolhe "Ontem", "7 dias"... em vez de "Agora". O score vem
 * da curva do turno (gold), os alertas de silver.alertas.
 */
export async function historico(u: Usuario, f: Filtros) {
  const sql = db();
  const linhas = await sql`
    WITH t AS (
        SELECT t.id, t.motorista_id, t.iniciado_em, t.veiculo_id, t.origem_cidade, t.destino_cidade,
               EXTRACT(EPOCH FROM (COALESCE(t.finalizado_em, (SELECT MAX(l.registrado_em) FROM silver.leituras_fadiga l WHERE l.turno_id = t.id), t.iniciado_em)
                                   - t.iniciado_em)) / 3600.0 AS horas
          FROM silver.turnos t
          JOIN silver.motoristas m ON m.id = t.motorista_id
         WHERE m.empresa_id = ${u.empresaId} AND m.arquivado_em IS NULL
           AND (t.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
    ),
    c AS (
        SELECT turno_id, SUM(soma_score) AS soma, SUM(leituras) AS n, MAX(score_fadiga_maximo) AS maximo
          FROM gold.mv_curva_fadiga_turno WHERE turno_id IN (SELECT id FROM t) GROUP BY turno_id
    ),
    a AS (
        SELECT turno_id, COUNT(*) AS alertas, COUNT(*) FILTER (WHERE gravidade IN ('alta', 'critica')) AS graves
          FROM silver.alertas WHERE turno_id IN (SELECT id FROM t) GROUP BY turno_id
    ),
    por_motorista AS (
        SELECT m.id AS motorista_id, m.codigo, m.nome_exibicao AS nome, m.idade, m.anos_experiencia,
               COALESCE(m.regiao_uf, 'ND') AS regiao_uf, COALESCE(uf.macro_regiao, 'ND') AS macro_regiao,
               COUNT(t.id)::int AS turnos,
               ROUND(SUM(t.horas)::numeric, 1) AS horas,
               ROUND(SUM(c.soma) / NULLIF(SUM(c.n), 0), 1) AS score_medio,
               ROUND(MAX(c.maximo), 0) AS score_maximo,
               COALESCE(SUM(a.alertas), 0)::int AS alertas,
               COALESCE(SUM(a.graves), 0)::int AS alertas_graves,
               MAX(t.iniciado_em) AS ultimo_turno_em,
               (array_agg(t.id ORDER BY t.iniciado_em DESC))[1] AS ultimo_turno_id,
               (array_agg(t.veiculo_id ORDER BY t.iniciado_em DESC))[1] AS veiculo_id,
               -- Rotas feitas no intervalo: o atalho "rota" da visão gerencial filtra por elas.
               COALESCE(array_agg(DISTINCT t.origem_cidade || ' → ' || t.destino_cidade)
                          FILTER (WHERE t.origem_cidade IS NOT NULL AND t.destino_cidade IS NOT NULL), '{}') AS rotas
          FROM t
          JOIN silver.motoristas m ON m.id = t.motorista_id
          LEFT JOIN silver.dim_uf uf ON uf.uf = m.regiao_uf
          LEFT JOIN c ON c.turno_id = t.id
          LEFT JOIN a ON a.turno_id = t.id
         GROUP BY m.id, uf.macro_regiao
    )
    SELECT * FROM (
        SELECT p.*, COALESCE(ve.tipo::text, 'nd') AS tipo_veiculo, ve.placa, d.codigo AS veiculo_codigo,
               (SELECT COUNT(*) FROM silver.incidentes i
                 WHERE i.motorista_id = p.motorista_id AND i.origem = 'interno'
                   AND (i.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate})::int AS ocorrencias,
               gold.fn_nivel_risco(p.score_maximo) AS risco
          FROM por_motorista p
          LEFT JOIN silver.veiculos ve ON ve.id = p.veiculo_id
          LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.veiculo_id = ve.id AND vd.fim IS NULL
          LEFT JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
    ) x
     WHERE TRUE ${condicoesDimensao(sql, f)}
     ORDER BY score_maximo DESC NULLS LAST, nome
  `;
  return linhas.map((m) => ({
    motoristaId: m.motorista_id as string,
    codigo: m.codigo as string | null,
    nome: m.nome as string,
    regiao: m.regiao_uf as string,
    tipoVeiculo: ROTULO_TIPO_VEICULO[m.tipo_veiculo as string] ?? m.tipo_veiculo,
    placa: m.placa as string | null,
    veiculoCodigo: m.veiculo_codigo as string | null,
    turnos: m.turnos as number,
    horas: m.horas as number | null,
    scoreMedio: m.score_medio as number | null,
    scoreMaximo: m.score_maximo as number | null,
    risco: m.risco as string,
    alertas: m.alertas as number,
    alertasGraves: m.alertas_graves as number,
    ocorrencias: m.ocorrencias as number,
    ultimoTurnoEm: m.ultimo_turno_em as string,
    ultimoTurnoId: m.ultimo_turno_id as string,
    rotas: m.rotas as string[],
  }));
}

/** Turnos do motorista no intervalo, do mais recente para o mais antigo. */
export async function turnos(u: Usuario, id: string, f: Filtros) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();
  const linhas = await sql`
    SELECT t.id, t.iniciado_em, t.finalizado_em, t.status::text AS status, t.origem_cidade, t.destino_cidade,
           ve.placa, d.codigo AS veiculo_codigo,
           ROUND(EXTRACT(EPOCH FROM (COALESCE(t.finalizado_em, c.ultima, t.iniciado_em) - t.iniciado_em)) / 3600.0, 1) AS horas,
           c.score_medio, c.score_maximo,
           (SELECT COUNT(*) FROM silver.alertas a WHERE a.turno_id = t.id)::int AS alertas,
           (SELECT COUNT(*) FROM silver.alertas a WHERE a.turno_id = t.id AND a.gravidade IN ('alta', 'critica'))::int AS alertas_graves
      FROM silver.turnos t
      LEFT JOIN LATERAL (
          SELECT ROUND(SUM(soma_score) / NULLIF(SUM(leituras), 0), 1) AS score_medio, ROUND(MAX(score_fadiga_maximo), 0) AS score_maximo,
                 (SELECT MAX(l.registrado_em) FROM silver.leituras_fadiga l WHERE l.turno_id = t.id) AS ultima
            FROM gold.mv_curva_fadiga_turno WHERE turno_id = t.id
      ) c ON TRUE
      LEFT JOIN silver.veiculos ve ON ve.id = t.veiculo_id
      LEFT JOIN silver.dispositivos d ON d.id = t.dispositivo_id
     WHERE t.motorista_id = ${id}
       AND (t.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN ${f.periodo.de} AND ${f.periodo.ate}
     ORDER BY t.iniciado_em DESC
     LIMIT 200
  `;
  return linhas.map((t) => ({
    turnoId: t.id as string,
    iniciadoEm: t.iniciado_em as string,
    finalizadoEm: t.finalizado_em as string | null,
    status: t.status as string,
    origem: t.origem_cidade as string | null,
    destino: t.destino_cidade as string | null,
    placa: t.placa as string | null,
    veiculoCodigo: t.veiculo_codigo as string | null,
    horas: t.horas as number | null,
    scoreMedio: t.score_medio as number | null,
    scoreMaximo: t.score_maximo as number | null,
    risco: nivelRisco(t.score_maximo === null ? null : Number(t.score_maximo)),
    alertas: t.alertas as number,
    alertasGraves: t.alertas_graves as number,
  }));
}

export async function detalhe(u: Usuario, id: string) {
  uuid.parse(id);
  const sql = db();
  const [[r], [vivo], [frota], ocorrencias, acoes, [alertaAberto]] = await Promise.all([
    sql`SELECT * FROM gold.mv_ranking_motoristas WHERE motorista_id = ${id} AND empresa_id = ${u.empresaId}`,
    sql`SELECT * FROM gold.vw_frota_agora WHERE motorista_id = ${id} AND empresa_id = ${u.empresaId}`,
    sql`SELECT ROUND(AVG(score_fadiga_medio), 1) AS media FROM gold.mv_ranking_motoristas
         WHERE empresa_id = ${u.empresaId} AND score_fadiga_medio IS NOT NULL`,
    // Acidentes e ocorrências da própria frota (não os da PRF), mais recentes primeiro.
    sql`SELECT id, ocorrido_em, gravidade::text AS gravidade, causa, tipo_acidente, municipio, uf,
               relacionado_sonolencia, descricao
          FROM silver.incidentes
         WHERE motorista_id = ${id} AND empresa_id = ${u.empresaId} AND origem = 'interno'
         ORDER BY ocorrido_em DESC LIMIT 10`,
    // Últimas ações da central com este motorista (painel "Ações da central").
    sql`SELECT ac.id, ac.tipo::text AS tipo, ac.detalhe,
               CASE WHEN ac.realizado_por IS NULL OR ac.descricao LIKE 'Resposta ao alerta de %' THEN NULL ELSE ac.descricao END AS observacao,
               ac.realizado_em, us.nome AS por, ac.alerta_id, al.tipo::text AS alerta_tipo,
               ac.realizado_em >= now() - make_interval(mins => ${MINUTOS_PARA_DESFAZER}) AS pode_desfazer
          FROM silver.acoes_motorista ac
          LEFT JOIN silver.usuarios us ON us.id = ac.realizado_por
          LEFT JOIN silver.alertas al ON al.id = ac.alerta_id
         WHERE ac.motorista_id = ${id} AND ac.realizado_em >= now() - interval '7 days'
         ORDER BY ac.realizado_em DESC LIMIT 6`,
    // O alerta que a próxima ação responde (o mesmo critério de registrarAcao).
    sql`SELECT id, tipo::text AS tipo, gravidade::text AS gravidade, disparado_em, score_fadiga
          FROM silver.alertas
         WHERE motorista_id = ${id} AND status = 'aberto' AND disparado_em >= now() - interval '2 hours'
         ORDER BY (gravidade IN ('alta', 'critica')) DESC, disparado_em DESC LIMIT 1`,
  ]);
  if (!r) throw naoEncontrado("Motorista");

  return {
    motoristaId: r.motorista_id,
    codigo: r.codigo,
    nome: r.motorista,
    idade: r.idade,
    anosExperiencia: r.anos_experiencia,
    regiao: r.regiao_uf,
    status: r.status,
    veiculo: {
      tipo: ROTULO_TIPO_VEICULO[r.tipo_veiculo as string] ?? r.tipo_veiculo,
      placa: r.placa,
      codigo: r.veiculo_codigo,
    },
    agora: vivo
      ? {
          score: vivo.score_atual,
          risco: vivo.risco,
          tendencia: vivo.tendencia,
          horasTurno: vivo.horas_turno,
          turnoStatus: vivo.turno_status,
          alertasHoje: vivo.alertas_hoje,
          blinkRate: vivo.blink_rate,
          fechamentoOlhosMs: vivo.duracao_olhos_fechados_ms,
          ultimaLeituraEm: vivo.ultima_leitura_em,
        }
      : null,
    ultimos30d: {
      scoreMedio: r.score_fadiga_medio,
      scoreMaximo: r.score_fadiga_maximo,
      nivelRisco: r.nivel_risco,
      posicaoRisco: r.posicao_risco,
      alertas: r.alertas_30d,
      alertasGraves: r.alertas_graves_30d,
      alertasAbertos: r.alertas_abertos,
      turnos: r.turnos_30d,
      horasDirigidas: r.horas_dirigidas_30d,
      duracaoMediaTurnoH: r.duracao_media_turno_h,
      kmRodados: r.km_rodados_30d,
      blinkRateMedio: r.blink_rate_medio,
      fechamentoOlhosMedioMs: r.fechamento_olhos_medio_ms,
      inclinacaoCabecaMedia: r.inclinacao_cabeca_media,
      mediaDaFrota: frota?.media ?? null,
    },
    ocorrencias: ocorrencias.map((o) => ({
      id: o.id as string,
      ocorridoEm: o.ocorrido_em as string,
      gravidade: o.gravidade as string | null,
      causa: o.causa as string | null,
      tipo: o.tipo_acidente as string | null,
      local: [o.municipio, o.uf].filter(Boolean).join(" - ") || null,
      relacionadoSonolencia: o.relacionado_sonolencia as boolean,
      descricao: o.descricao as string | null,
    })),
    acoesRecentes: acoes.map((a) => ({
      id: a.id as string,
      tipo: a.tipo as string,
      detalhe: a.detalhe as string | null,
      observacao: a.observacao as string | null,
      em: a.realizado_em as string,
      por: a.por as string | null,
      alertaId: a.alerta_id as string | null,
      alertaRotulo: a.alerta_tipo ? (ROTULO_ALERTA[a.alerta_tipo as string] ?? (a.alerta_tipo as string)) : null,
      podeDesfazer: a.pode_desfazer as boolean,
    })),
    alertaAberto: alertaAberto
      ? {
          id: alertaAberto.id as string,
          rotulo: ROTULO_ALERTA[alertaAberto.tipo as string] ?? (alertaAberto.tipo as string),
          gravidade: alertaAberto.gravidade as string,
          disparadoEm: alertaAberto.disparado_em as string,
          score: alertaAberto.score_fadiga as number | null,
        }
      : null,
  };
}

export async function curvaTurno(u: Usuario, id: string, turnoId?: string) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();

  const [turno] = turnoId
    ? await sql`SELECT id, iniciado_em, finalizado_em, status::text AS status, origem_cidade, destino_cidade
                  FROM silver.turnos WHERE id = ${uuid.parse(turnoId)} AND motorista_id = ${id}`
    : await sql`SELECT t.id, t.iniciado_em, t.finalizado_em, t.status::text AS status, t.origem_cidade, t.destino_cidade
                  FROM silver.turnos t
                 WHERE t.motorista_id = ${id}
                   AND EXISTS (SELECT 1 FROM silver.leituras_fadiga l WHERE l.turno_id = t.id)
                 ORDER BY t.iniciado_em DESC LIMIT 1`;

  const [pontos, frota] = await Promise.all([
    turno
      ? sql`SELECT hora_do_turno, score_fadiga_medio, score_fadiga_maximo, leituras
              FROM gold.mv_curva_fadiga_turno WHERE turno_id = ${turno.id} ORDER BY hora_do_turno`
      : Promise.resolve([]),
    sql`SELECT hora_direcao, ROUND(SUM(soma_score) / NULLIF(SUM(leituras), 0), 1) AS fadiga
          FROM gold.mv_fadiga_por_tempo_direcao
         WHERE empresa_id = ${u.empresaId} AND dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 6
           AND hora_direcao < 14
         GROUP BY hora_direcao ORDER BY hora_direcao`,
  ]);

  const horas = Math.max(12, ...pontos.map((p) => (p.hora_do_turno as number) + 1));
  return {
    turno: turno
      ? {
          turnoId: turno.id,
          iniciadoEm: turno.iniciado_em,
          finalizadoEm: turno.finalizado_em,
          status: turno.status,
          origem: turno.origem_cidade,
          destino: turno.destino_cidade,
        }
      : null,
    limiteAlerta: 70,
    pontos: Array.from({ length: Math.min(horas, 15) }, (_, h) => {
      const p = pontos.find((x) => x.hora_do_turno === h);
      const fr = frota.find((x) => x.hora_direcao === h);
      return {
        hora: `${h + 1}h`,
        fadiga: p?.score_fadiga_medio ?? null,
        maximo: p?.score_fadiga_maximo ?? null,
        mediaFrota: fr?.fadiga ?? null,
      };
    }),
  };
}

/**
 * As leituras dos últimos minutos, uma a uma, direto da Silver: o gráfico
 * "agora" do painel do motorista (a curva do turno vem da Gold, por hora, e
 * só atualiza a cada 5 min). Com os alertas do mesmo intervalo.
 */
export async function leiturasRecentes(u: Usuario, id: string, minutos = 15) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const janela = Math.min(60, Math.max(1, Math.round(Number(minutos) || 15)));
  const sql = db();
  const [leituras, alertas] = await Promise.all([
    sql`SELECT registrado_em, score_fadiga, estado::text AS estado, perclos, ear, blink_rate
          FROM silver.leituras_fadiga
         WHERE motorista_id = ${id} AND registrado_em >= now() - make_interval(mins => ${janela})
         ORDER BY registrado_em`,
    sql`SELECT id, disparado_em, tipo::text AS tipo, gravidade::text AS gravidade, score_fadiga, status::text AS status
          FROM silver.alertas
         WHERE motorista_id = ${id} AND disparado_em >= now() - make_interval(mins => ${janela})
         ORDER BY disparado_em`,
  ]);
  return {
    minutos: janela,
    leituras: leituras.map((l) => ({
      em: l.registrado_em as string,
      score: l.score_fadiga as number | null,
      estado: l.estado as string,
      perclos: l.perclos as number | null,
      ear: l.ear as number | null,
      blinkRate: l.blink_rate as number | null,
    })),
    alertas: alertas.map((a) => ({
      id: a.id as string,
      em: a.disparado_em as string,
      tipo: a.tipo as string,
      rotulo: ROTULO_ALERTA[a.tipo as string] ?? (a.tipo as string),
      gravidade: a.gravidade as string,
      score: a.score_fadiga as number | null,
      status: a.status as string,
    })),
  };
}

export interface InsightMotorista {
  nivel: "low" | "medium" | "high" | "critical";
  icone: "alerta" | "pausa" | "tendencia" | "olho" | "reincidencia" | "ok" | "frota" | "ia";
  titulo: string;
  descricao: string;
  origem: "regra" | "modelo";
}

/** Regras sobre o estado atual e os 30 dias do motorista. */
export function regrasMotorista(d: Awaited<ReturnType<typeof detalhe>>): InsightMotorista[] {
  const lista: InsightMotorista[] = [];
  const a = d.agora;
  const ult = d.ultimos30d;

  if (a?.score !== undefined && a.score !== null && a.score >= 75) {
    lista.push({ nivel: a.score >= 85 ? "critical" : "high", icone: "tendencia", titulo: "Fadiga acima do limite agora",
      descricao: `Score atual ${a.score}/100, acima do limite de alerta (70).`, origem: "regra" });
  }
  if (a?.horasTurno && a.horasTurno >= 6 && a.turnoStatus === "em_andamento") {
    lista.push({ nivel: a.horasTurno >= 8 ? "high" : "medium", icone: "pausa", titulo: "Pausa recomendada",
      descricao: `Dirige há ${a.horasTurno}h neste turno. A fadiga da frota sobe a partir da 6ª hora.`, origem: "regra" });
  }
  if (a && ((a.fechamentoOlhosMs ?? 0) >= 400 || (a.blinkRate !== null && a.blinkRate !== undefined && a.blinkRate >= 28))) {
    lista.push({ nivel: "high", icone: "olho", titulo: "Sinais de microssono",
      descricao: `Fechamento ocular de ${a.fechamentoOlhosMs ?? "—"} ms e ${a.blinkRate ?? "—"} piscadas/min na última leitura.`, origem: "regra" });
  }
  if (a && a.alertasHoje >= 4) {
    lista.push({ nivel: "critical", icone: "reincidencia", titulo: "Reincidência no dia",
      descricao: `${a.alertasHoje} alertas emitidos hoje para este motorista.`, origem: "regra" });
  }
  if (ult.scoreMedio !== null && ult.mediaDaFrota !== null && ult.scoreMedio > ult.mediaDaFrota * 1.15) {
    lista.push({ nivel: "medium", icone: "frota", titulo: "Acima da média da frota",
      descricao: `Fadiga média de ${formatarNumero(ult.scoreMedio, 1)} em 30 dias, contra ${formatarNumero(ult.mediaDaFrota, 1)} da frota.`, origem: "regra" });
  }
  if (ult.alertasGraves >= 5) {
    lista.push({ nivel: "high", icone: "alerta", titulo: "Alertas graves recorrentes",
      descricao: `${ult.alertasGraves} alertas de gravidade alta ou crítica nos últimos 30 dias. Avalie escala e treinamento.`, origem: "regra" });
  }
  const DIA_MS = 86_400_000;
  // Acidente tem gravidade; sem gravidade é quase-acidente (ocorrência sem acidente).
  const sono90d = d.ocorrencias.filter((o) => o.gravidade && o.relacionadoSonolencia && Date.now() - new Date(o.ocorridoEm).getTime() <= 90 * DIA_MS);
  const quase30d = d.ocorrencias.filter((o) => !o.gravidade && o.relacionadoSonolencia && Date.now() - new Date(o.ocorridoEm).getTime() <= 30 * DIA_MS);
  if (quase30d.length > 0 && sono90d.length === 0) {
    lista.push({ nivel: "high", icone: "alerta", titulo: "Quase acidente por sono nos últimos 30 dias",
      descricao: `${quase30d.length} ocorrência(s) sem acidente ligada(s) à sonolência (${quase30d[0].tipo?.replace("Quase acidente: ", "") ?? "quase acidente"}). Sinal de alerta para escala e pausas.`, origem: "regra" });
  }
  if (sono90d.length > 0) {
    const ultima = sono90d[0];
    lista.push({ nivel: "critical", icone: "alerta", titulo: "Acidente por sono nos últimos 90 dias",
      descricao: `${sono90d.length} ocorrência(s) ligada(s) à sonolência; a última em ${new Date(ultima.ocorridoEm).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}${ultima.local ? ` (${ultima.local})` : ""}. Priorize pausas e revise a escala.`, origem: "regra" });
  }
  if (lista.length === 0) {
    lista.push({ nivel: "low", icone: "ok", titulo: "Operação dentro do esperado",
      descricao: "Nenhum padrão crítico identificado nas leituras recentes.", origem: "regra" });
  }
  return lista;
}

const NIVEL_DE_GRAVIDADE: Record<string, InsightMotorista["nivel"]> = { baixa: "low", media: "medium", alta: "high", critica: "critical" };

export async function insights(u: Usuario, id: string) {
  const d = await detalhe(u, id);
  const sql = db();
  const ia = await sql`
    SELECT titulo, descricao, severidade::text AS severidade, gerado_em
      FROM silver.insights_motorista
     WHERE motorista_id = ${id} AND origem = 'modelo'
       AND (valido_ate IS NULL OR valido_ate > now())
     ORDER BY gerado_em DESC LIMIT 2
  `;
  const daIa: InsightMotorista[] = ia.map((i) => ({
    nivel: NIVEL_DE_GRAVIDADE[i.severidade as string] ?? "medium",
    icone: "ia",
    titulo: i.titulo as string,
    descricao: (i.descricao as string) ?? "",
    origem: "modelo",
  }));
  const ordem = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...regrasMotorista(d), ...daIa].sort((a, b) => ordem[a.nivel] - ordem[b.nivel]).slice(0, 5);
}

export async function alertas(u: Usuario, id: string, limite = 20) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();
  const linhas = await sql`
    SELECT id, disparado_em, tipo::text AS tipo, gravidade::text AS gravidade, status::text AS status,
           score_fadiga, mensagem, reconhecido_em
      FROM silver.alertas WHERE motorista_id = ${id}
     ORDER BY disparado_em DESC LIMIT ${Math.min(100, Math.max(1, limite))}
  `;
  return linhas.map((a) => ({ ...a, rotulo: ROTULO_ALERTA[a.tipo as string] ?? a.tipo }));
}

export const schemaAcao = z.object({
  tipo: z.enum([
    "pausa_obrigatoria",
    "contato_telefonico",
    "tentativa_contato",
    "troca_motorista",
    "encerramento_turno",
    "monitorando",
    "treinamento",
    "advertencia",
  ]),
  /** Opção escolhida: duração da pausa, canal do contato... */
  detalhe: z.string().trim().max(100).optional(),
  /** Observação da central (antes "descricao", que continua aceito). */
  observacao: z.string().trim().max(500).optional(),
  descricao: z.string().max(1000).optional(),
  alertaId: z.string().uuid().optional(),
});

/** Ações que falam com o motorista ou mudam a viagem: respondem ao alerta aberto. */
const RESPONDEM_ALERTA = [...ACOES_QUE_ATENDEM, "tentativa_contato", "monitorando"];


export async function registrarAcao(u: Usuario, id: string, dados: z.infer<typeof schemaAcao>) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();

  return sql.begin(async (tx) => {
    const [turno] = await tx`
      SELECT id FROM silver.turnos WHERE motorista_id = ${id} AND status = 'em_andamento' LIMIT 1
    `;
    // Sem alerta informado, a ação responde ao alerta grave mais recente ainda
    // aberto (2 h). Treinamento e advertência são de depois: não respondem a alerta.
    const [alerta] = dados.alertaId
      ? await tx`SELECT id FROM silver.alertas WHERE id = ${dados.alertaId} AND motorista_id = ${id}`
      : RESPONDEM_ALERTA.includes(dados.tipo)
        ? await tx`SELECT id FROM silver.alertas
                    WHERE motorista_id = ${id} AND status = 'aberto'
                      AND disparado_em >= now() - interval '2 hours'
                    ORDER BY (gravidade IN ('alta', 'critica')) DESC, disparado_em DESC LIMIT 1`
        : [];
    if (dados.alertaId && !alerta) throw naoEncontrado("Alerta");

    const [acao] = await tx`
      INSERT INTO silver.acoes_motorista (motorista_id, turno_id, alerta_id, tipo, detalhe, descricao, realizado_por)
      VALUES (${id}, ${turno?.id ?? null}, ${alerta?.id ?? null}, ${dados.tipo}::silver.tipo_acao,
              ${dados.detalhe || null}, ${dados.observacao || dados.descricao || null}, ${autor(u)})
      RETURNING id, tipo::text AS tipo, realizado_em, alerta_id, turno_id
    `;

    // Como na resposta pelo alerta: só a tentativa sem sucesso o mantém aguardando.
    if (alerta && dados.tipo !== "tentativa_contato") {
      await tx`
        UPDATE silver.alertas
           SET status = 'reconhecido', reconhecido_por = ${autor(u)}, reconhecido_em = COALESCE(reconhecido_em, now())
         WHERE id = ${alerta.id} AND status = 'aberto'
      `;
    }
    return acao;
  });
}

/** Desfaz uma ação registrada por engano (até MINUTOS_PARA_DESFAZER depois). */
export async function desfazerAcao(u: Usuario, id: string, acaoId: string) {
  uuid.parse(id);
  uuid.parse(acaoId);
  await garantirDaEmpresa(u, id);
  const sql = db();
  const [acao] = await sql`
    SELECT alerta_id, realizado_em >= now() - make_interval(mins => ${MINUTOS_PARA_DESFAZER}) AS recente
      FROM silver.acoes_motorista WHERE id = ${acaoId} AND motorista_id = ${id}
  `;
  if (!acao) throw naoEncontrado("Ação");
  // Ligada a um alerta: o alerta volta a aguardar se ficar sem resposta.
  if (acao.alerta_id) return desfazerResposta(u, acao.alerta_id as string, acaoId);
  if (!acao.recente) throw conflito(`Só dá para desfazer nos primeiros ${MINUTOS_PARA_DESFAZER} minutos`);
  await sql`DELETE FROM silver.acoes_motorista WHERE id = ${acaoId}`;
  return { status: "desfeita" };
}

export const schemaOcorrencia = z.object({
  descricao: z.string().min(3).max(2000),
  gravidade: z.enum(["sem_vitimas", "com_feridos", "com_fatais"]).optional(),
  ocorridoEm: z.string().datetime({ offset: true }).optional(),
  relacionadoSonolencia: z.boolean().default(false),
  causa: z.string().max(200).optional(),
});

export async function registrarOcorrencia(u: Usuario, id: string, dados: z.infer<typeof schemaOcorrencia>) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();
  const [ocorrencia] = await sql`
    WITH ctx AS (
        SELECT m.id AS motorista_id, m.regiao_uf,
               (SELECT t.id FROM silver.turnos t WHERE t.motorista_id = m.id ORDER BY t.iniciado_em DESC LIMIT 1) AS turno_id,
               (SELECT t.veiculo_id FROM silver.turnos t WHERE t.motorista_id = m.id ORDER BY t.iniciado_em DESC LIMIT 1) AS veiculo_id
          FROM silver.motoristas m WHERE m.id = ${id}
    )
    INSERT INTO silver.incidentes (empresa_id, motorista_id, veiculo_id, turno_id, origem, ocorrido_em, uf,
                                   causa, gravidade, descricao, relacionado_sonolencia, registrado_por)
    SELECT ${u.empresaId}, ctx.motorista_id, ctx.veiculo_id, ctx.turno_id, 'interno',
           COALESCE(${dados.ocorridoEm ?? null}::timestamptz, now()), ctx.regiao_uf,
           ${dados.causa ?? null}, ${dados.gravidade ?? null}::silver.gravidade_incidente,
           ${dados.descricao}, ${dados.relacionadoSonolencia}, ${autor(u)}
      FROM ctx
    RETURNING id, ocorrido_em, gravidade::text AS gravidade
  `;
  return ocorrencia;
}
