/** Lambda "motoristas" (VPC): lista ao vivo, detalhe, curva, insights e ações rápidas. */

import { lerFiltros } from "../lib/filtros";
import { corpo, criado, ok } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as servico from "../servicos/motoristas";

export const handler = criarRoteador("motoristas", {
  aoVivo: async ({ usuario, query }) => ok(await servico.aoVivo(usuario, lerFiltros(query))),
  historico: async ({ usuario, query }) => ok(await servico.historico(usuario, lerFiltros(query, "hoje"))),
  turnos: async ({ usuario, params, query }) => ok(await servico.turnos(usuario, params.id, lerFiltros(query, "hoje"))),
  detalhe: async ({ usuario, params }) => ok(await servico.detalhe(usuario, params.id)),
  curvaTurno: async ({ usuario, params, query }) => ok(await servico.curvaTurno(usuario, params.id, query.turno_id)),
  insights: async ({ usuario, params }) => ok(await servico.insights(usuario, params.id)),
  alertas: async ({ usuario, params, query }) => ok(await servico.alertas(usuario, params.id, Number(query.limite ?? 20))),
  registrarAcao: async ({ usuario, params, corpo: texto, base64 }) =>
    criado(await servico.registrarAcao(usuario, params.id, corpo(texto, servico.schemaAcao, base64))),
  desfazerAcao: async ({ usuario, params }) => ok(await servico.desfazerAcao(usuario, params.id, params.acaoId)),
  registrarOcorrencia: async ({ usuario, params, corpo: texto, base64 }) =>
    criado(await servico.registrarOcorrencia(usuario, params.id, corpo(texto, servico.schemaOcorrencia, base64))),
});
