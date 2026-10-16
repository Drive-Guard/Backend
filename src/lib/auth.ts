/**
 * Quem está chamando a API.
 *
 * O autorizador JWT da API HTTP já validou a assinatura e a validade do ID
 * token do Cognito antes de a Lambda rodar; aqui só se leem as claims:
 *
 *   sub                -> id do usuário (vira silver.usuarios.id)
 *   email, name
 *   custom:empresa_id  -> empresa: toda consulta filtra por ela
 *   cognito:groups     -> papéis (admin, gestor, operador)
 *
 * O API Gateway entrega cognito:groups como TEXTO, no formato "[admin gestor]",
 * e não como lista. parsePapeis aceita os dois.
 */

import { createHash } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { db } from "./db";
import { ErroHttp, proibido } from "./http";

export const PAPEIS = ["admin", "gestor", "operador"] as const;
export type Papel = (typeof PAPEIS)[number];

export interface Usuario {
  id: string;
  email: string;
  nome: string;
  empresaId: string;
  papeis: Papel[];
  /** Papel de maior privilégio (admin > gestor > operador). */
  papel: Papel;
  /** Trabalho agendado, sem pessoa por trás: não entra em colunas "feito por". */
  sistema?: boolean;
}

/** Usuário dos trabalhos agendados (insights, relatórios agendados). */
export function usuarioSistema(empresaId: string): Usuario {
  return { id: "", email: "", nome: "DriveGuard", empresaId, papeis: ["admin"], papel: "admin", sistema: true };
}

/** Id para gravar em colunas como realizado_por/solicitado_por (null para o sistema). */
export const autor = (u: Usuario): string | null => (u.sistema ? null : u.id);

export function parsePapeis(valor: unknown): Papel[] {
  let itens: string[] = [];
  if (Array.isArray(valor)) itens = valor.map(String);
  else if (typeof valor === "string") itens = valor.replace(/^\[|\]$/g, "").split(/[\s,]+/);
  return PAPEIS.filter((p) => itens.includes(p));
}

export function usuarioDoEvento(evento: APIGatewayProxyEventV2WithJWTAuthorizer): Usuario {
  const claims = evento.requestContext?.authorizer?.jwt?.claims ?? {};
  return usuarioDasClaims(claims as Record<string, unknown>);
}

export function usuarioDasClaims(claims: Record<string, unknown>): Usuario {
  const id = String(claims.sub ?? "");
  const empresaId = String(claims["custom:empresa_id"] ?? "");
  const papeis = parsePapeis(claims["cognito:groups"]);

  if (!id) throw new ErroHttp(401, "Token sem identificação do usuário");
  if (!/^[0-9a-f-]{36}$/i.test(empresaId)) throw proibido("Usuário sem empresa associada. Peça a um administrador para concluir o cadastro.");
  if (papeis.length === 0) throw proibido("Usuário sem papel. Peça a um administrador para atribuir admin, gestor ou operador.");

  return {
    id,
    email: String(claims.email ?? ""),
    nome: String(claims.name ?? claims.email ?? "Usuário"),
    empresaId,
    papeis,
    papel: PAPEIS.find((p) => papeis.includes(p))!,
  };
}

export function exigirPapel(usuario: Usuario, permitidos: readonly Papel[]): void {
  if (!usuario.papeis.some((p) => permitidos.includes(p))) throw proibido();
}

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex");

/**
 * Garante o usuário em silver.usuarios (id = sub do Cognito), para as ações
 * registradas na dashboard apontarem para quem as fez. Roda no máximo uma vez
 * a cada 5 minutos por usuário em cada container.
 */
const vistos = new Map<string, number>();

export async function garantirUsuario(usuario: Usuario): Promise<void> {
  const agora = Date.now();
  const chave = `${usuario.id}:${usuario.empresaId}:${usuario.papel}`;
  if ((vistos.get(chave) ?? 0) > agora - 5 * 60_000) return;

  const sql = db();
  const [empresa] = await sql`SELECT 1 FROM silver.empresas WHERE id = ${usuario.empresaId}`;
  if (!empresa) throw proibido("A empresa do seu usuário não está cadastrada no DriveGuard.");

  const emailHash = sha256(usuario.email.toLowerCase());
  // Um usuário recriado no Cognito ganha outro sub com o mesmo e-mail: o
  // registro antigo fica (as ações antigas apontam para ele), só libera o hash.
  await sql`
    UPDATE silver.usuarios SET email_hash = email_hash || ':substituido:' || id::text, ativo = FALSE
     WHERE email_hash = ${emailHash} AND id <> ${usuario.id}
  `;
  await sql`
    INSERT INTO silver.usuarios (id, empresa_id, email_hash, nome, papel, ultimo_acesso_em)
    VALUES (${usuario.id}, ${usuario.empresaId}, ${emailHash},
            ${usuario.nome}, ${usuario.papel}::silver.papel_usuario, now())
    ON CONFLICT (id) DO UPDATE
       SET nome = EXCLUDED.nome, papel = EXCLUDED.papel, empresa_id = EXCLUDED.empresa_id,
           ultimo_acesso_em = now(), ativo = TRUE
  `;
  vistos.set(chave, agora);
}
