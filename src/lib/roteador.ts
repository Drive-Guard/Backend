/**
 * Roteador das Lambdas da API.
 *
 * Cada Lambda atende as rotas de um domínio (dashboard, motoristas, ...). O
 * API Gateway entrega o routeKey ("GET /motoristas/{id}"); o roteador acha a
 * rota no manifesto, confere o papel do usuário e chama a ação.
 */

import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { exigirPapel, garantirUsuario, usuarioDoEvento, type Usuario } from "./auth";
import { erro, ErroHttp, type Resposta } from "./http";
import { chaveDaRota, rotas, type FuncaoApi, type Rota } from "../rotas";

export type Evento = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface Contexto {
  usuario: Usuario;
  rota: Rota;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  corpo: string | undefined;
  base64: boolean;
}

export type Acao = (ctx: Contexto) => Promise<Resposta>;

export interface OpcoesRoteador {
  /** A Lambda não fala com o banco (ex.: usuários, no Cognito): não registra o usuário. */
  semBanco?: boolean;
}

export function criarRoteador(funcao: FuncaoApi, acoes: Record<string, Acao>, opcoes: OpcoesRoteador = {}) {
  const minhas = rotas.filter((r) => r.funcao === funcao);
  const faltando = minhas.filter((r) => !acoes[r.acao]).map((r) => r.acao);
  if (faltando.length) throw new Error(`Ações sem implementação em ${funcao}: ${faltando.join(", ")}`);
  const porChave = new Map(minhas.map((r) => [chaveDaRota(r), r]));

  return async function handler(evento: Evento): Promise<Resposta> {
    const inicio = Date.now();
    const rota = porChave.get(evento.routeKey);
    let resposta: Resposta;
    let usuarioId: string | undefined;

    try {
      if (!rota) throw new ErroHttp(404, `Rota não encontrada: ${evento.routeKey}`);
      const usuario = usuarioDoEvento(evento);
      usuarioId = usuario.id;
      exigirPapel(usuario, rota.papeis);
      if (!opcoes.semBanco) await garantirUsuario(usuario);

      resposta = await acoes[rota.acao]({
        usuario,
        rota,
        params: (evento.pathParameters ?? {}) as Record<string, string>,
        query: evento.queryStringParameters ?? {},
        corpo: evento.body,
        base64: !!evento.isBase64Encoded,
      });
    } catch (e) {
      resposta = erro(e);
    }

    console.log(
      JSON.stringify({
        rota: evento.routeKey,
        status: resposta.statusCode,
        ms: Date.now() - inicio,
        usuario: usuarioId,
      }),
    );
    return resposta;
  };
}
