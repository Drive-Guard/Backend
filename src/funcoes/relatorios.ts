/** Lambda "relatorios" (VPC): resumo da aba, geração, histórico, download e agendamentos. */

import { corpo, criado, ok, semConteudo } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as agendamentos from "../servicos/relatorios/agendamentos";
import * as servico from "../servicos/relatorios";

export const handler = criarRoteador("relatorios", {
  resumo: async ({ usuario, query }) =>
    ok(await servico.resumo(servico.contexto(usuario, servico.schemaFiltrosRelatorio.parse(query)))),
  listar: async ({ usuario }) => ok(await servico.listar(usuario)),
  gerar: async ({ usuario, corpo: texto, base64 }) => criado(await servico.gerar(usuario, corpo(texto, servico.schemaPedido, base64))),
  download: async ({ usuario, params }) => ok(await servico.download(usuario, params.id)),
  remover: async ({ usuario, params }) => ok(await servico.remover(usuario, params.id)),
  listarAgendamentos: async ({ usuario }) => ok(await agendamentos.listar(usuario)),
  criarAgendamento: async ({ usuario, corpo: texto, base64 }) =>
    criado(await agendamentos.criar(usuario, corpo(texto, agendamentos.schemaAgendamento, base64))),
  atualizarAgendamento: async ({ usuario, params, corpo: texto, base64 }) =>
    ok(await agendamentos.atualizar(usuario, params.id, corpo(texto, agendamentos.schemaAgendamento, base64))),
  removerAgendamento: async ({ usuario, params }) => {
    await agendamentos.remover(usuario, params.id);
    return semConteudo();
  },
});
