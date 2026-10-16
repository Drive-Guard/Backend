/**
 * Respostas HTTP e erros no formato da API HTTP do API Gateway (payload 2.0).
 */

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { z } from "zod";

// Mensagens de validação em português (a dashboard mostra o texto ao usuário).
z.config(z.locales.ptBR());

export type Resposta = APIGatewayProxyStructuredResultV2;

export class ErroHttp extends Error {
  constructor(
    public readonly status: number,
    mensagem: string,
    public readonly detalhes?: unknown,
  ) {
    super(mensagem);
  }
}

export const naoEncontrado = (registro = "Registro") => new ErroHttp(404, `${registro} não encontrado`);
export const proibido = (motivo = "Seu papel não permite esta ação") => new ErroHttp(403, motivo);
export const conflito = (motivo: string) => new ErroHttp(409, motivo);
export const invalido = (motivo: string, detalhes?: unknown) => new ErroHttp(400, motivo, detalhes);

const CABECALHOS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export function json(status: number, corpo: unknown): Resposta {
  return { statusCode: status, headers: CABECALHOS, body: JSON.stringify(corpo) };
}

export const ok = (corpo: unknown) => json(200, corpo);
export const criado = (corpo: unknown) => json(201, corpo);
export const semConteudo = (): Resposta => ({ statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" });

export function csv(nomeArquivo: string, conteudo: string): Resposta {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
      "Cache-Control": "no-store",
    },
    // BOM: o Excel abre o CSV em UTF-8 com acento certo.
    body: "﻿" + conteudo,
  };
}

export function erro(e: unknown): Resposta {
  if (e instanceof ErroHttp) {
    return json(e.status, { erro: e.message, ...(e.detalhes ? { detalhes: e.detalhes } : {}) });
  }
  if (e instanceof z.ZodError) {
    return json(400, {
      erro: "Dados inválidos",
      detalhes: e.issues.map((i) => ({ campo: i.path.join("."), mensagem: i.message })),
    });
  }
  // Violação de constraint do PostgreSQL vira erro do cliente, não 500.
  const pg = e as { code?: string; detail?: string; constraint_name?: string };
  if (pg?.code === "23505") return json(409, { erro: "Já existe um registro com esses dados", detalhes: pg.detail });
  if (pg?.code === "23503") return json(400, { erro: "Referência inválida", detalhes: pg.detail });
  if (pg?.code === "23514") return json(400, { erro: "Valor fora do permitido", detalhes: pg.constraint_name });
  if (pg?.code === "22P02") return json(400, { erro: "Formato inválido", detalhes: pg.detail });

  console.error("Erro não tratado", e);
  return json(500, { erro: "Erro interno" });
}

/** Lê o corpo JSON e valida com o schema. */
export function corpo<T extends z.ZodTypeAny>(texto: string | undefined | null, schema: T, base64 = false): z.infer<T> {
  let bruto: unknown = {};
  if (texto) {
    try {
      bruto = JSON.parse(base64 ? Buffer.from(texto, "base64").toString("utf8") : texto);
    } catch {
      throw invalido("Corpo da requisição não é JSON válido");
    }
  }
  return schema.parse(bruto);
}
