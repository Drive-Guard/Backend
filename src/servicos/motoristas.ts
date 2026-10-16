/**
 * Aba Motoristas: lista ao vivo, detalhe, curva do turno, insights e ações.
 */

import { z } from "zod";
import { autor, type Usuario } from "../lib/auth";
import { db } from "../lib/db";
import { condicoesDimensao, type Filtros, ROTULO_TIPO_VEICULO } from "../lib/filtros";
import { naoEncontrado } from "../lib/http";
import { JANELA_AO_VIVO, ROTULO_ALERTA } from "./dashboard";

async function garantirDaEmpresa(u: Usuario, motoristaId: string) {
  const sql = db();
  const [m] = await sql`SELECT id FROM silver.motoristas WHERE id = ${motoristaId} AND empresa_id = ${u.empresaId}`;
  if (!m) throw naoEncontrado("Motorista");
}

const uuid = z.string().uuid("id inválido");

export async function aoVivo(u: Usuario, f: Filtros) {
  const sql = db();
  const linhas = await sql`
    SELECT f.*, f.ultima_leitura_em >= now() - ${JANELA_AO_VIVO}::interval AS ativo,
           r.score_fadiga_medio AS score_medio_30d
      FROM gold.vw_frota_agora f
      LEFT JOIN gold.mv_ranking_motoristas r ON r.motorista_id = f.motorista_id
     WHERE f.empresa_id = ${u.empresaId} ${condicoesDimensao(sql, f)}
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
    tendencia: m.tendencia,
    blinkRate: m.blink_rate,
    fechamentoOlhosMs: m.duracao_olhos_fechados_ms,
    inclinacaoCabeca: m.head_pitch !== null ? Math.abs(m.head_pitch as number) : null,
    perclos: m.perclos,
    alertasHoje: m.alertas_hoje,
    ultimaLeituraEm: m.ultima_leitura_em,
    ativo: m.ativo,
    scoreMedio30d: m.score_medio_30d,
  }));
}

export async function detalhe(u: Usuario, id: string) {
  uuid.parse(id);
  const sql = db();
  const [[r], [vivo], [frota], ocorrencias] = await Promise.all([
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
      descricao: `Fadiga média de ${ult.scoreMedio} em 30 dias, contra ${ult.mediaDaFrota} da frota.`, origem: "regra" });
  }
  if (ult.alertasGraves >= 5) {
    lista.push({ nivel: "high", icone: "alerta", titulo: "Alertas graves recorrentes",
      descricao: `${ult.alertasGraves} alertas de gravidade alta ou crítica nos últimos 30 dias. Avalie escala e treinamento.`, origem: "regra" });
  }
  const DIA_MS = 86_400_000;
  const sono90d = d.ocorrencias.filter((o) => o.relacionadoSonolencia && Date.now() - new Date(o.ocorridoEm).getTime() <= 90 * DIA_MS);
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
  tipo: z.enum(["pausa_obrigatoria", "contato_telefonico", "troca_motorista", "treinamento", "advertencia", "encerramento_turno"]),
  descricao: z.string().max(1000).optional(),
  alertaId: z.string().uuid().optional(),
});

/** Ações que contam como "alerta atendido" no indicador do ROI. */
const ACOES_QUE_ATENDEM = ["pausa_obrigatoria", "encerramento_turno", "troca_motorista"];

export async function registrarAcao(u: Usuario, id: string, dados: z.infer<typeof schemaAcao>) {
  uuid.parse(id);
  await garantirDaEmpresa(u, id);
  const sql = db();

  return sql.begin(async (tx) => {
    const [turno] = await tx`
      SELECT id FROM silver.turnos WHERE motorista_id = ${id} AND status = 'em_andamento' LIMIT 1
    `;
    // Sem alerta informado, a ação responde ao alerta grave mais recente ainda aberto (2 h).
    const [alerta] = dados.alertaId
      ? await tx`SELECT id FROM silver.alertas WHERE id = ${dados.alertaId} AND motorista_id = ${id}`
      : await tx`SELECT id FROM silver.alertas
                  WHERE motorista_id = ${id} AND status = 'aberto'
                    AND disparado_em >= now() - interval '2 hours'
                  ORDER BY (gravidade IN ('alta', 'critica')) DESC, disparado_em DESC LIMIT 1`;
    if (dados.alertaId && !alerta) throw naoEncontrado("Alerta");

    const [acao] = await tx`
      INSERT INTO silver.acoes_motorista (motorista_id, turno_id, alerta_id, tipo, descricao, realizado_por)
      VALUES (${id}, ${turno?.id ?? null}, ${alerta?.id ?? null}, ${dados.tipo}::silver.tipo_acao,
              ${dados.descricao ?? null}, ${autor(u)})
      RETURNING id, tipo::text AS tipo, realizado_em, alerta_id, turno_id
    `;

    if (alerta && ACOES_QUE_ATENDEM.includes(dados.tipo)) {
      await tx`
        UPDATE silver.alertas
           SET status = 'reconhecido', reconhecido_por = ${autor(u)}, reconhecido_em = COALESCE(reconhecido_em, now())
         WHERE id = ${alerta.id} AND status = 'aberto'
      `;
    }
    return acao;
  });
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
