/**
 * Alertas da frota (visão técnica): lista e atualização de status.
 *
 * O alerta acontece na cabine, em tempo real, no dispositivo embarcado; o que
 * chega aqui é o registro dele. Reconhecer na dashboard é o operador dizendo
 * que viu e tratou.
 */

import { z } from "zod";
import { autor, type Usuario } from "../lib/auth";
import { db } from "../lib/db";
import { conflito, invalido, naoEncontrado } from "../lib/http";
import { ACOES_QUE_ATENDEM, MINUTOS_PARA_DESFAZER, ROTULO_ALERTA } from "./dashboard";

export const schemaFiltroAlertas = z.object({
  status: z.enum(["aberto", "reconhecido", "resolvido", "descartado"]).optional(),
  gravidade: z.enum(["baixa", "media", "alta", "critica"]).optional(),
  motorista_id: z.string().uuid().optional(),
  horas: z.coerce.number().int().min(1).max(24 * 31).default(24),
  limite: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listar(u: Usuario, f: z.infer<typeof schemaFiltroAlertas>) {
  const sql = db();
  const linhas = await sql`
    SELECT a.id, a.disparado_em, a.tipo::text AS tipo, a.gravidade::text AS gravidade, a.status::text AS status,
           a.score_fadiga, a.mensagem, a.reconhecido_em, a.resolvido_em,
           m.id AS motorista_id, m.codigo, m.nome_exibicao AS nome,
           v.placa, d.codigo AS veiculo_codigo, v.tipo::text AS tipo_veiculo,
           EXISTS (SELECT 1 FROM silver.acoes_motorista ac WHERE ac.alerta_id = a.id) AS tem_acao
      FROM silver.alertas a
      JOIN silver.motoristas m ON m.id = a.motorista_id
      LEFT JOIN silver.veiculos v ON v.id = a.veiculo_id
      LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.veiculo_id = v.id AND vd.fim IS NULL
      LEFT JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
     WHERE m.empresa_id = ${u.empresaId}
       AND a.disparado_em >= now() - make_interval(hours => ${f.horas})
       ${f.status ? sql`AND a.status = ${f.status}::silver.status_alerta` : sql``}
       ${f.gravidade ? sql`AND a.gravidade = ${f.gravidade}::silver.gravidade` : sql``}
       ${f.motorista_id ? sql`AND a.motorista_id = ${f.motorista_id}` : sql``}
     ORDER BY a.disparado_em DESC
     LIMIT ${f.limite}
  `;
  return linhas.map((a) => ({ ...a, rotulo: ROTULO_ALERTA[a.tipo as string] ?? a.tipo }));
}

export const schemaAtualizacao = z.object({
  status: z.enum(["reconhecido", "resolvido", "descartado"]),
});

export async function atualizar(u: Usuario, id: string, dados: z.infer<typeof schemaAtualizacao>) {
  z.string().uuid().parse(id);
  const sql = db();
  const [alerta] = await sql`
    UPDATE silver.alertas a
       SET status          = ${dados.status}::silver.status_alerta,
           reconhecido_por = COALESCE(a.reconhecido_por, ${autor(u)}::uuid),
           reconhecido_em  = COALESCE(a.reconhecido_em, now()),
           resolvido_em    = CASE WHEN ${dados.status} IN ('resolvido', 'descartado') THEN now() ELSE a.resolvido_em END
      FROM silver.motoristas m
     WHERE a.id = ${id} AND m.id = a.motorista_id AND m.empresa_id = ${u.empresaId}
    RETURNING a.id, a.status::text AS status, a.reconhecido_em, a.resolvido_em
  `;
  if (!alerta) throw naoEncontrado("Alerta");
  return alerta;
}

// ---------------------------------------------------------------------------
// Resposta da central (aba Monitoramento)
// ---------------------------------------------------------------------------

/**
 * O que a central pode responder a um alerta. Um alerta aceita várias
 * respostas em sequência (não atendeu -> pediu pausa -> falou com ele).
 *   - pausa, contato, troca e encerramento: atendem o alerta (ACOES_QUE_ATENDEM,
 *     o indicador "graves atendidos" da Visão Gerencial, do ROI e dos relatórios);
 *   - tentativa_contato: registra a tentativa e o alerta segue aguardando;
 *   - monitorando, treinamento, advertência: a central viu e decidiu; sai do
 *     "aguardando", mas não conta como atendido;
 *   - falso_alarme: descarta o alerta, com o motivo (retorno para o modelo).
 */
export const TIPOS_RESPOSTA = [
  "pausa_obrigatoria",
  "contato_telefonico",
  "tentativa_contato",
  "troca_motorista",
  "encerramento_turno",
  "monitorando",
  "treinamento",
  "advertencia",
  "falso_alarme",
] as const;

export const MOTIVOS_DESCARTE = ["motorista_bem", "camera", "oculos", "iluminacao", "outro"] as const;

export const schemaResposta = z
  .object({
    tipo: z.enum(TIPOS_RESPOSTA),
    /** Opção da resposta: duração da pausa, canal do contato... */
    detalhe: z.string().trim().max(100).optional(),
    observacao: z.string().trim().max(500).optional(),
    motivo: z.enum(MOTIVOS_DESCARTE).optional(),
    /** Aplica também aos outros alertas abertos do mesmo motorista no turno. */
    outrosAbertos: z.boolean().default(false),
  })
  .refine((d) => d.tipo !== "falso_alarme" || d.motivo, { message: "Informe o motivo do falso alarme", path: ["motivo"] });

export async function responder(u: Usuario, id: string, dados: z.infer<typeof schemaResposta>) {
  z.string().uuid().parse(id);
  const sql = db();
  return sql.begin(async (tx) => {
    const [alerta] = await tx`
      SELECT a.id, a.motorista_id, a.turno_id, a.disparado_em, a.status::text AS status
        FROM silver.alertas a JOIN silver.motoristas m ON m.id = a.motorista_id
       WHERE a.id = ${id} AND m.empresa_id = ${u.empresaId}
    `;
    if (!alerta) throw naoEncontrado("Alerta");
    if (alerta.status === "descartado" && dados.tipo !== "falso_alarme") {
      throw conflito("Alerta marcado como falso alarme: desfaça o falso alarme antes de registrar uma ação");
    }

    // Os outros abertos do mesmo motorista: mesmo turno ou, sem turno, as 2 h em volta.
    const mesmoTurno = alerta.turno_id
      ? tx`turno_id = ${alerta.turno_id}`
      : tx`disparado_em BETWEEN ${alerta.disparado_em}::timestamptz - interval '2 hours' AND ${alerta.disparado_em}::timestamptz + interval '2 hours'`;
    const outros = dados.outrosAbertos
      ? await tx`
          SELECT id FROM silver.alertas
           WHERE motorista_id = ${alerta.motorista_id} AND status = 'aberto' AND id <> ${id} AND ${mesmoTurno}
        `
      : [];
    const alvos = [id, ...outros.map((o) => o.id as string)];

    if (dados.tipo === "falso_alarme") {
      await tx`
        UPDATE silver.alertas
           SET status = 'descartado', motivo_descarte = ${dados.motivo!}, observacao_descarte = ${dados.observacao || null},
               reconhecido_por = COALESCE(reconhecido_por, ${autor(u)}::uuid), reconhecido_em = COALESCE(reconhecido_em, now()),
               resolvido_em = now()
         WHERE id = ANY(${tx.array(alvos)}::uuid[])
      `;
      return { aplicados: alvos.length, atende: false };
    }

    // A ação vai para o turno do alerta (ou o turno em andamento, se o alerta não tiver).
    const [turno] = alerta.turno_id
      ? [{ id: alerta.turno_id }]
      : await tx`SELECT id FROM silver.turnos WHERE motorista_id = ${alerta.motorista_id} AND status = 'em_andamento' LIMIT 1`;
    for (const alvo of alvos) {
      await tx`
        INSERT INTO silver.acoes_motorista (motorista_id, turno_id, alerta_id, tipo, detalhe, descricao, realizado_por)
        VALUES (${alerta.motorista_id}, ${turno?.id ?? null}, ${alvo}, ${dados.tipo}::silver.tipo_acao,
                ${dados.detalhe || null}, ${dados.observacao || null}, ${autor(u)})
      `;
    }
    // Só a tentativa sem sucesso mantém o alerta aguardando.
    if (dados.tipo !== "tentativa_contato") {
      await tx`
        UPDATE silver.alertas
           SET status = 'reconhecido', reconhecido_por = ${autor(u)}, reconhecido_em = COALESCE(reconhecido_em, now())
         WHERE id = ANY(${tx.array(alvos)}::uuid[]) AND status = 'aberto'
      `;
    }
    return { aplicados: alvos.length, atende: ACOES_QUE_ATENDEM.includes(dados.tipo) };
  });
}

/**
 * Desfaz uma resposta dada por engano (até MINUTOS_PARA_DESFAZER depois).
 * `resposta` é o id da ação ou "falso_alarme". Sem outra resposta que tire o
 * alerta do "aguardando", ele volta a aberto.
 */
export async function desfazerResposta(u: Usuario, id: string, resposta: string) {
  z.string().uuid().parse(id);
  if (resposta !== "falso_alarme") z.string().uuid("resposta inválida").parse(resposta);
  const sql = db();
  return sql.begin(async (tx) => {
    const [alerta] = await tx`
      SELECT a.id, a.status::text AS status,
             COALESCE(a.resolvido_em >= now() - make_interval(mins => ${MINUTOS_PARA_DESFAZER}), FALSE) AS recente
        FROM silver.alertas a JOIN silver.motoristas m ON m.id = a.motorista_id
       WHERE a.id = ${id} AND m.empresa_id = ${u.empresaId}
    `;
    if (!alerta) throw naoEncontrado("Alerta");

    if (resposta === "falso_alarme") {
      if (alerta.status !== "descartado") throw invalido("O alerta não está marcado como falso alarme");
      if (!alerta.recente) throw conflito(`Só dá para desfazer nos primeiros ${MINUTOS_PARA_DESFAZER} minutos`);
      // Volta ao estado das ações que já tinha (reconhecido) ou a aberto.
      await tx`
        UPDATE silver.alertas a
           SET motivo_descarte = NULL, observacao_descarte = NULL, resolvido_em = NULL,
               status = CASE WHEN EXISTS (SELECT 1 FROM silver.acoes_motorista ac WHERE ac.alerta_id = a.id AND ac.tipo <> 'tentativa_contato')
                             THEN 'reconhecido' ELSE 'aberto' END::silver.status_alerta
         WHERE a.id = ${id}
      `;
    } else {
      const [acao] = await tx`
        SELECT id, realizado_em >= now() - make_interval(mins => ${MINUTOS_PARA_DESFAZER}) AS recente
          FROM silver.acoes_motorista WHERE id = ${resposta} AND alerta_id = ${id}
      `;
      if (!acao) throw naoEncontrado("Resposta");
      if (!acao.recente) throw conflito(`Só dá para desfazer nos primeiros ${MINUTOS_PARA_DESFAZER} minutos`);
      await tx`DELETE FROM silver.acoes_motorista WHERE id = ${resposta}`;
    }

    // Volta a aguardar se não sobrou resposta que decida o alerta.
    await tx`
      UPDATE silver.alertas a
         SET status = 'aberto', reconhecido_por = NULL, reconhecido_em = NULL
       WHERE a.id = ${id} AND a.status = 'reconhecido'
         AND NOT EXISTS (SELECT 1 FROM silver.acoes_motorista ac WHERE ac.alerta_id = a.id AND ac.tipo <> 'tentativa_contato')
    `;
    const [r] = await tx`SELECT status::text AS status FROM silver.alertas WHERE id = ${id}`;
    return { status: r.status as string };
  });
}
