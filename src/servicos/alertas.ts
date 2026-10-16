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
import { naoEncontrado } from "../lib/http";
import { ROTULO_ALERTA } from "./dashboard";

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
