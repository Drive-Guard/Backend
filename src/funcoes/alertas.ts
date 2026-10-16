/** Lambda "alertas" (VPC): lista e tratamento dos alertas. */

import { corpo, ok } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as servico from "../servicos/alertas";

export const handler = criarRoteador("alertas", {
  listar: async ({ usuario, query }) => ok(await servico.listar(usuario, servico.schemaFiltroAlertas.parse(query))),
  atualizar: async ({ usuario, params, corpo: texto, base64 }) =>
    ok(await servico.atualizar(usuario, params.id, corpo(texto, servico.schemaAtualizacao, base64))),
});
