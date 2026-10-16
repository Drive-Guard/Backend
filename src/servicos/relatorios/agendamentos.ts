/**
 * Agendamentos de relatórios: CRUD da tela e a execução periódica (Lambda
 * agendamentos, a cada 15 minutos, dentro da VPC).
 */

import { z } from "zod";
import { autor, usuarioSistema, type Usuario } from "../../lib/auth";
import { db } from "../../lib/db";
import { naoEncontrado } from "../../lib/http";
import { diaLocal, instanteLocal, partesLocais, somarDias } from "../../lib/tempo";
import { schemaFiltrosRelatorio } from "./dados";
import { FORMATOS, TIPOS_RELATORIO } from "./documento";
import { gerar, periodoDoAgendamento } from "./index";

export const schemaAgendamento = z
  .object({
    tipo: z.enum(TIPOS_RELATORIO),
    formato: z.enum(FORMATOS),
    frequencia: z.enum(["diaria", "semanal", "mensal"]),
    horario: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM"),
    diaSemana: z.number().int().min(0).max(6).optional(),
    diaMes: z.number().int().min(1).max(28).optional(),
    destinatarios: z.array(z.string().trim().email("e-mail inválido")).min(1, "informe ao menos um destinatário").max(20),
    filtros: schemaFiltrosRelatorio.default({}),
    ativo: z.boolean().default(true),
  })
  .refine((a) => a.frequencia !== "semanal" || a.diaSemana !== undefined, { message: "informe o dia da semana", path: ["diaSemana"] })
  .refine((a) => a.frequencia !== "mensal" || a.diaMes !== undefined, { message: "informe o dia do mês", path: ["diaMes"] });

export type Agendamento = z.infer<typeof schemaAgendamento>;

/** Próximo instante de execução depois de `apos`, no horário de Brasília. */
export function proximaExecucao(a: Pick<Agendamento, "frequencia" | "horario" | "diaSemana" | "diaMes">, apos = new Date()): Date {
  const hoje = diaLocal(apos);
  for (let i = 0; i <= 62; i++) {
    const dia = somarDias(hoje, i);
    const quando = instanteLocal(dia, a.horario);
    if (quando <= apos) continue;
    const p = partesLocais(quando);
    if (a.frequencia === "diaria") return quando;
    if (a.frequencia === "semanal" && p.diaSemana === a.diaSemana) return quando;
    if (a.frequencia === "mensal" && p.dia === a.diaMes) return quando;
  }
  throw new Error("Não foi possível calcular a próxima execução");
}

const COLUNAS = (sqlTag: ReturnType<typeof db>) => sqlTag`
  id, tipo::text AS tipo, formato::text AS formato, frequencia::text AS frequencia, to_char(horario, 'HH24:MI') AS horario,
  dia_semana AS "diaSemana", dia_mes AS "diaMes", destinatarios, filtros, ativo, proxima_execucao AS "proximaExecucao",
  ultima_execucao AS "ultimaExecucao", criado_em AS "criadoEm"
`;

export async function listar(u: Usuario) {
  const sql = db();
  return sql`SELECT ${COLUNAS(sql)} FROM silver.agendamentos_relatorio WHERE empresa_id = ${u.empresaId} ORDER BY criado_em DESC`;
}

export async function criar(u: Usuario, a: Agendamento) {
  const sql = db();
  const [r] = await sql`
    INSERT INTO silver.agendamentos_relatorio (empresa_id, criado_por, tipo, formato, frequencia, horario, dia_semana, dia_mes,
                                               destinatarios, filtros, ativo, proxima_execucao)
    VALUES (${u.empresaId}, ${autor(u)}, ${a.tipo}::silver.tipo_relatorio, ${a.formato}::silver.formato_relatorio,
            ${a.frequencia}::silver.frequencia_agendamento, ${a.horario}::time, ${a.diaSemana ?? null}, ${a.diaMes ?? null},
            ${sql.array(a.destinatarios)}, ${sql.json(a.filtros as never)}, ${a.ativo}, ${proximaExecucao(a)})
    RETURNING ${COLUNAS(sql)}
  `;
  return r;
}

export async function atualizar(u: Usuario, id: string, a: Agendamento) {
  z.string().uuid().parse(id);
  const sql = db();
  const [r] = await sql`
    UPDATE silver.agendamentos_relatorio
       SET tipo = ${a.tipo}::silver.tipo_relatorio, formato = ${a.formato}::silver.formato_relatorio,
           frequencia = ${a.frequencia}::silver.frequencia_agendamento, horario = ${a.horario}::time,
           dia_semana = ${a.diaSemana ?? null}, dia_mes = ${a.diaMes ?? null}, destinatarios = ${sql.array(a.destinatarios)},
           filtros = ${sql.json(a.filtros as never)}, ativo = ${a.ativo}, proxima_execucao = ${proximaExecucao(a)}
     WHERE id = ${id} AND empresa_id = ${u.empresaId}
    RETURNING ${COLUNAS(sql)}
  `;
  if (!r) throw naoEncontrado("Agendamento");
  return r;
}

export async function remover(u: Usuario, id: string) {
  z.string().uuid().parse(id);
  const sql = db();
  const r = await sql`DELETE FROM silver.agendamentos_relatorio WHERE id = ${id} AND empresa_id = ${u.empresaId} RETURNING id`;
  if (!r.length) throw naoEncontrado("Agendamento");
}

/**
 * Executa os agendamentos vencidos. FOR UPDATE SKIP LOCKED: duas execuções
 * sobrepostas da Lambda nunca geram o mesmo relatório duas vezes.
 */
export async function executarVencidos(limite = 20) {
  const sql = db();
  const feitos: { id: string; relatorio?: string; erro?: string }[] = [];

  for (let i = 0; i < limite; i++) {
    const resultado = await sql.begin(async (tx) => {
      const [a] = await tx`
        SELECT id, empresa_id, tipo::text AS tipo, formato::text AS formato, frequencia::text AS frequencia,
               to_char(horario, 'HH24:MI') AS horario, dia_semana, dia_mes, destinatarios, filtros
          FROM silver.agendamentos_relatorio
         WHERE ativo AND proxima_execucao <= now()
         ORDER BY proxima_execucao
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      `;
      if (!a) return null;
      const proxima = proximaExecucao({
        frequencia: a.frequencia as Agendamento["frequencia"],
        horario: a.horario as string,
        diaSemana: (a.dia_semana as number | null) ?? undefined,
        diaMes: (a.dia_mes as number | null) ?? undefined,
      });
      await tx`UPDATE silver.agendamentos_relatorio SET ultima_execucao = now(), proxima_execucao = ${proxima} WHERE id = ${a.id}`;
      return a;
    });
    if (!resultado) break;

    try {
      const r = await gerar(
        usuarioSistema(resultado.empresa_id as string),
        {
          tipo: resultado.tipo as Agendamento["tipo"],
          formato: resultado.formato as Agendamento["formato"],
          filtros: periodoDoAgendamento(resultado.frequencia as string, schemaFiltrosRelatorio.parse(resultado.filtros ?? {})),
          destinatarios: resultado.destinatarios as string[],
        },
        resultado.id as string,
      );
      feitos.push({ id: resultado.id as string, relatorio: r.id });
    } catch (e) {
      console.error("Falha no agendamento", resultado.id, e);
      feitos.push({ id: resultado.id as string, erro: (e as Error).message });
    }
  }
  return feitos;
}
