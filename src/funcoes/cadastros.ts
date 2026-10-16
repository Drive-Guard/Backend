/** Lambda "cadastros" (VPC): empresa, motoristas, veículos, câmeras, rotas, viagens e parâmetros do ROI. */

import { z } from "zod";
import { corpo, criado, ok } from "../lib/http";
import { criarRoteador } from "../lib/roteador";
import * as s from "../servicos/cadastros";

const motivo = z.object({ motivo: z.string().max(200).optional().nullable() });

export const handler = criarRoteador("cadastros", {
  empresa: async ({ usuario }) => ok(await s.empresa(usuario)),
  atualizarEmpresa: async ({ usuario, corpo: t, base64 }) => ok(await s.atualizarEmpresa(usuario, corpo(t, s.schemaEmpresa, base64))),
  ufs: async () => ok(await s.ufs()),

  listarMotoristas: async ({ usuario }) => ok(await s.listarMotoristas(usuario)),
  criarMotorista: async ({ usuario, corpo: t, base64 }) => criado(await s.criarMotorista(usuario, corpo(t, s.schemaNovoMotorista, base64))),
  atualizarMotorista: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.atualizarMotorista(usuario, params.id, corpo(t, s.schemaMotorista, base64))),

  listarVeiculos: async ({ usuario }) => ok(await s.listarVeiculos(usuario)),
  criarVeiculo: async ({ usuario, corpo: t, base64 }) => criado(await s.criarVeiculo(usuario, corpo(t, s.schemaNovoVeiculo, base64))),
  atualizarVeiculo: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.atualizarVeiculo(usuario, params.id, corpo(t, s.schemaVeiculo, base64))),

  listarDispositivos: async ({ usuario }) => ok(await s.listarDispositivos(usuario)),
  criarDispositivo: async ({ usuario, corpo: t, base64 }) =>
    criado(await s.criarDispositivo(usuario, corpo(t, s.schemaNovoDispositivo, base64))),
  atualizarDispositivo: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.atualizarDispositivo(usuario, params.id, corpo(t, s.schemaDispositivo, base64))),
  vincularDispositivo: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.vincularDispositivo(usuario, params.id, corpo(t, s.schemaVinculo, base64))),
  desvincularDispositivo: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.desvincularDispositivo(usuario, params.id, corpo(t, motivo, base64).motivo)),
  historicoDispositivo: async ({ usuario, params }) => ok(await s.historicoDispositivo(usuario, params.id)),

  listarRotas: async ({ usuario }) => ok(await s.listarRotas(usuario)),
  criarRota: async ({ usuario, corpo: t, base64 }) => criado(await s.criarRota(usuario, corpo(t, s.schemaRota, base64))),
  atualizarRota: async ({ usuario, params, corpo: t, base64 }) => ok(await s.atualizarRota(usuario, params.id, corpo(t, s.schemaRota, base64))),

  listarViagens: async ({ usuario, query }) => ok(await s.listarViagens(usuario, s.schemaFiltroViagens.parse(query))),
  criarViagem: async ({ usuario, corpo: t, base64 }) => criado(await s.criarViagem(usuario, corpo(t, s.schemaViagem, base64))),
  atualizarViagem: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.atualizarViagem(usuario, params.id, corpo(t, s.schemaViagem, base64))),

  listarParametrosRoi: async ({ usuario }) => ok(await s.listarParametrosRoi(usuario)),
  definirParametroRoi: async ({ usuario, params, corpo: t, base64 }) =>
    ok(await s.definirParametroRoi(usuario, params.chave, corpo(t, s.schemaParametro, base64))),
  restaurarParametroRoi: async ({ usuario, params }) => ok(await s.restaurarParametroRoi(usuario, params.chave)),
});
