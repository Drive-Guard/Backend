/**
 * Geração, histórico, download e envio dos relatórios.
 *
 * A geração roda na própria requisição (os dados já vêm agregados, um PDF de
 * poucas páginas sai em menos de um segundo). O envio por e-mail é assíncrono:
 * a Lambda da VPC grava relatorios/envios/<id>.json, a de fora da VPC tenta o
 * SES e devolve o resultado em relatorios/resultados/<id>.json. Sem SES (o
 * Learner Lab bloqueia), o relatório continua disponível na dashboard.
 */

import { z } from "zod";
import { autor, type Usuario } from "../../lib/auth";
import { gravar, gravarJson, linkTemporario } from "../../lib/arquivos";
import { db, type Sql } from "../../lib/db";
import { naoEncontrado } from "../../lib/http";
import { diaLocal, somarDias } from "../../lib/tempo";
import { contexto, documento, schemaFiltrosRelatorio, type FiltrosRelatorio } from "./dados";
import { FORMATOS, MIME, TIPOS_RELATORIO, TITULO_RELATORIO, type Formato, type TipoRelatorio } from "./documento";
import { renderizarPdf } from "./pdf";
import { renderizarCsv, renderizarXlsx } from "./planilha";

export { resumo, contexto, schemaFiltrosRelatorio } from "./dados";

const email = z.string().trim().email("e-mail inválido");

export const schemaPedido = z.object({
  tipo: z.enum(TIPOS_RELATORIO),
  formato: z.enum(FORMATOS),
  filtros: schemaFiltrosRelatorio.default({}),
  destinatarios: z.array(email).max(20).default([]),
});

export const chaveArquivo = (empresaId: string, id: string, formato: Formato) => `relatorios/arquivos/${empresaId}/${id}.${formato}`;
export const chaveEnvio = (id: string) => `relatorios/envios/${id}.json`;

export function nomeArquivo(tipo: TipoRelatorio, formato: Formato, quando = new Date()) {
  return `driveguard-${tipo}-${diaLocal(quando)}.${formato}`;
}

export async function renderizar(doc: Awaited<ReturnType<typeof documento>>, formato: Formato): Promise<Buffer> {
  if (formato === "pdf") return renderizarPdf(doc);
  if (formato === "xlsx") return renderizarXlsx(doc);
  return renderizarCsv(doc);
}

export interface PedidoEnvio {
  relatorioId: string;
  empresaId: string;
  destinatarios: string[];
  assunto: string;
  titulo: string;
  periodo: string;
  nomeArquivo: string;
  chave: string;
  linkDashboard: string;
}

/** Gera, guarda e (se pedido) agenda o envio. Usado pela API e pelos agendamentos. */
export async function gerar(u: Usuario, pedido: z.infer<typeof schemaPedido>, agendamentoId: string | null = null) {
  const sql = db();
  const c = contexto(u, pedido.filtros);
  const [registro] = await sql`
    INSERT INTO silver.relatorios_gerados (empresa_id, agendamento_id, solicitado_por, tipo, formato, filtros, status, destinatarios)
    VALUES (${u.empresaId}, ${agendamentoId}, ${autor(u)}, ${pedido.tipo}::silver.tipo_relatorio,
            ${pedido.formato}::silver.formato_relatorio, ${sql.json(pedido.filtros as never)}, 'gerando',
            ${sql.array(pedido.destinatarios)})
    RETURNING id
  `;
  const id = registro.id as string;

  try {
    const doc = await documento(c, pedido.tipo);
    const arquivo = await renderizar(doc, pedido.formato);
    const chave = chaveArquivo(u.empresaId, id, pedido.formato);
    await gravar(chave, arquivo, MIME[pedido.formato]);
    const nome = nomeArquivo(pedido.tipo, pedido.formato);

    const querEnvio = pedido.destinatarios.length > 0;
    await sql`
      UPDATE silver.relatorios_gerados
         SET status = 'pronto', s3_key = ${chave}, tamanho_bytes = ${arquivo.length}, concluido_em = now(),
             envio = ${querEnvio ? "pendente" : "nao_solicitado"}::silver.status_envio
       WHERE id = ${id}
    `;

    if (querEnvio) {
      const envio: PedidoEnvio = {
        relatorioId: id,
        empresaId: u.empresaId,
        destinatarios: pedido.destinatarios,
        assunto: `DriveGuard: ${TITULO_RELATORIO[pedido.tipo]} (${doc.subtitulo.split(" • ")[0]})`,
        titulo: TITULO_RELATORIO[pedido.tipo],
        periodo: doc.subtitulo,
        nomeArquivo: nome,
        chave,
        linkDashboard: `${(process.env.SITE_URL ?? "").replace(/\/$/, "")}/?aba=relatorios&relatorio=${id}`,
      };
      await gravarJson(chaveEnvio(id), envio);
    }

    return {
      id,
      status: "pronto",
      nomeArquivo: nome,
      tamanhoBytes: arquivo.length,
      url: await linkTemporario(chave, nome),
      envio: querEnvio ? "pendente" : "nao_solicitado",
    };
  } catch (e) {
    await sql`UPDATE silver.relatorios_gerados SET status = 'erro', erro = ${String((e as Error).message).slice(0, 1000)}, concluido_em = now() WHERE id = ${id}`;
    throw e;
  }
}

export async function listar(u: Usuario) {
  const sql = db();
  return sql`
    SELECT r.id, r.tipo::text AS tipo, r.formato::text AS formato, r.status::text AS status, r.filtros, r.tamanho_bytes,
           r.erro, r.envio::text AS envio, r.envio_erro, r.enviado_em, r.destinatarios, r.criado_em, r.concluido_em,
           r.agendamento_id, u.nome AS solicitado_por
      FROM silver.relatorios_gerados r
      LEFT JOIN silver.usuarios u ON u.id = r.solicitado_por
     WHERE r.empresa_id = ${u.empresaId}
     ORDER BY r.criado_em DESC
     LIMIT 50
  `;
}

export async function download(u: Usuario, id: string) {
  z.string().uuid().parse(id);
  const sql = db();
  const [r] = await sql`
    SELECT s3_key, tipo::text AS tipo, formato::text AS formato, criado_em, status::text AS status
      FROM silver.relatorios_gerados WHERE id = ${id} AND empresa_id = ${u.empresaId}
  `;
  if (!r || r.status !== "pronto" || !r.s3_key) throw naoEncontrado("Relatório");
  const nome = nomeArquivo(r.tipo as TipoRelatorio, r.formato as Formato, r.criado_em as Date);
  return { url: await linkTemporario(r.s3_key as string, nome), nomeArquivo: nome, expiraEmSegundos: 900 };
}

// ---------------------------------------------------------------------------
// Resultado do envio (gravado pela Lambda de fora da VPC)
// ---------------------------------------------------------------------------

export interface ResultadoEnvio {
  relatorioId: string;
  status: "enviado" | "falhou";
  erro: string | null;
  enviadoEm: string | null;
}

export async function registrarResultadoEnvio(r: ResultadoEnvio, sql: Sql = db()) {
  await sql`
    UPDATE silver.relatorios_gerados
       SET envio = ${r.status}::silver.status_envio, envio_erro = ${r.erro}, enviado_em = ${r.enviadoEm}::timestamptz
     WHERE id = ${r.relatorioId}
  `;
}

/** Período padrão de um relatório agendado, quando o agendamento não fixa um. */
export function periodoDoAgendamento(frequencia: string, filtros: FiltrosRelatorio): FiltrosRelatorio {
  if (filtros.periodo || filtros.de) return filtros;
  const hoje = diaLocal();
  if (frequencia === "diaria") return { ...filtros, de: somarDias(hoje, -1), ate: somarDias(hoje, -1) };
  if (frequencia === "semanal") return { ...filtros, de: somarDias(hoje, -7), ate: somarDias(hoje, -1) };
  return { ...filtros, de: somarDias(hoje, -30), ate: somarDias(hoje, -1) };
}
