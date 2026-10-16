/** Utilitários dos testes: usuários e eventos falsos do API Gateway. */

import type { Papel, Usuario } from "../src/lib/auth";

export const EMPRESA_DEMO = "00000000-0000-4000-8000-000000000001";

export function usuario(papel: Papel = "gestor", empresaId = EMPRESA_DEMO): Usuario {
  const sub = { admin: "a", gestor: "b", operador: "c" }[papel];
  return {
    id: `00000000-0000-4000-9000-00000000000${sub}`,
    email: `${papel}@teste.local`,
    nome: `${papel} de teste`,
    empresaId,
    papeis: [papel],
    papel,
  };
}

export function evento(
  routeKey: string,
  opcoes: { papel?: Papel; params?: Record<string, string>; query?: Record<string, string>; corpo?: unknown; empresaId?: string } = {},
) {
  const u = usuario(opcoes.papel ?? "gestor", opcoes.empresaId);
  return {
    routeKey,
    pathParameters: opcoes.params ?? {},
    queryStringParameters: opcoes.query ?? {},
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
    isBase64Encoded: false,
    requestContext: {
      authorizer: {
        jwt: {
          claims: { sub: u.id, email: u.email, name: u.nome, "custom:empresa_id": u.empresaId, "cognito:groups": `[${u.papel}]` },
          scopes: null,
        },
      },
    },
  } as never;
}

export const corpoJson = (r: { body?: string }) => JSON.parse(r.body ?? "null");
