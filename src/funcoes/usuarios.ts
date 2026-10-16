/** Lambda "usuarios" (FORA da VPC): administração de usuários no Cognito. */

import { corpo, criado, ok, semConteudo } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as s from "../servicos/usuarios";

export const handler = criarRoteador(
  "usuarios",
  {
    listar: async ({ usuario }) => ok(await s.listar(usuario)),
    criar: async ({ usuario, corpo: t, base64 }) => criado(await s.criar(usuario, corpo(t, s.schemaNovoUsuario, base64))),
    atualizar: async ({ usuario, params, corpo: t, base64 }) =>
      ok(await s.atualizar(usuario, decodeURIComponent(params.username), corpo(t, s.schemaAtualizacaoUsuario, base64))),
    remover: async ({ usuario, params }) => {
      await s.remover(usuario, decodeURIComponent(params.username));
      return semConteudo();
    },
    redefinirSenha: async ({ usuario, params }) => ok(await s.redefinirSenha(usuario, decodeURIComponent(params.username))),
  },
  { semBanco: true },
);
