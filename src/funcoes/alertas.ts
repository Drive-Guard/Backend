/** Lambda "alertas" (VPC): lista e tratamento dos alertas. */

import { corpo, criado, ok } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as servico from "../servicos/alertas";

export const handler = criarRoteador("alertas", {
  listar: async ({ usuario, query }) => ok(await servico.listar(usuario, servico.schemaFiltroAlertas.parse(query))),
  atualizar: async ({ usuario, params, corpo: texto, base64 }) =>
    ok(await servico.atualizar(usuario, params.id, corpo(texto, servico.schemaAtualizacao, base64))),
  responder: async ({ usuario, params, corpo: texto, base64 }) =>
    criado(await servico.responder(usuario, params.id, corpo(texto, servico.schemaResposta, base64))),
  desfazerResposta: async ({ usuario, params }) => ok(await servico.desfazerResposta(usuario, params.id, params.respostaId)),
});
