/** Lambda "dashboard" (VPC): visão geral, base da PRF, insights e ROI. */

import { db } from "../lib/db";
import { lerFiltros } from "../lib/filtros";
import { csv, json, ok } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import { diaLocal } from "../lib/tempo";
import * as servico from "../servicos/dashboard";
import * as insights from "../servicos/insights";
import * as roi from "../servicos/roi";

export const handler = criarRoteador("dashboard", {
  async me({ usuario }) {
    const sql = db();
    const [e] = await sql`SELECT id, COALESCE(nome_fantasia, razao_social) AS nome, frota_total FROM silver.empresas WHERE id = ${usuario.empresaId}`;
    return ok({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      papeis: usuario.papeis,
      empresa: { id: e.id, nome: e.nome, frotaTotal: e.frota_total },
    });
  },
  kpis: async ({ usuario, query }) => ok(await servico.kpis(usuario, lerFiltros(query))),
  alertasTempoReal: async ({ usuario, query }) => ok(await servico.alertasTempoReal(usuario, lerFiltros(query))),
  tendenciaTurno: async ({ usuario, query }) => ok(await servico.tendenciaTurno(usuario, lerFiltros(query, "7d"))),
  evolucaoFadiga: async ({ usuario, query }) => ok(await servico.evolucaoFadiga(usuario, lerFiltros(query, "30d"))),
  rotas: async ({ usuario, query }) => ok(await servico.rotas(usuario, lerFiltros(query))),
  // O heatmap tem calendário próprio (de/ate); os outros filtros valem.
  heatmap: async ({ usuario, query }) => ok(await servico.heatmap(usuario, lerFiltros({ ...query, de: undefined, ate: undefined }, "7d"), query)),
  fadigaTempoDirecao: async ({ usuario, query }) => ok(await servico.fadigaTempoDirecao(usuario, lerFiltros(query, "30d"))),
  prfResumo: async ({ query }) => ok(await servico.prfResumo(lerFiltros(query), query)),
  prfFaixaHoraria: async ({ query }) => ok(await servico.prfFaixaHoraria(lerFiltros(query), query)),
  prfCausas: async ({ query }) => ok(await servico.prfCausas(lerFiltros(query), query)),
  prfMapa: async ({ query }) => ok(await servico.prfMapa(lerFiltros(query), query)),
  insights: async ({ usuario }) => ok(await insights.ultimos(usuario.empresaId)),
  gerarInsights: async ({ usuario }) => json(202, await insights.pedir(usuario.empresaId)),
  roi: async ({ usuario }) => ok(await roi.calcular(usuario.empresaId)),
  exportar: async ({ usuario, query }) =>
    csv(`driveguard-motoristas-${diaLocal()}.csv`, await servico.exportarCsv(usuario, lerFiltros(query))),
});
