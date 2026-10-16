/**
 * Lambdas de segundo plano. Cada export é uma função no serverless.ts:
 *
 *   insightsContexto  VPC   agendada (1 h)              monta o contexto -> S3
 *   insightsIa        fora  S3 insights/contextos/      Gemini ou regras -> S3
 *   insightsGravar    VPC   S3 insights/respostas/      grava no banco
 *   agendamentos      VPC   agendada (15 min)           gera os relatórios vencidos
 *   relatorioEnviar   fora  S3 relatorios/envios/       tenta o SES -> S3
 *   relatorioStatus   VPC   S3 relatorios/resultados/   grava o resultado do envio
 */

import { gravarJson, lerJson, objetoDoEvento } from "../lib/arquivos";
import * as insights from "../servicos/insights";
import { gerarInsights } from "../servicos/insights/ia";
import type { ContextoInsights, RespostaInsights } from "../servicos/insights/tipos";
import { registrarResultadoEnvio, type PedidoEnvio, type ResultadoEnvio } from "../servicos/relatorios";
import { executarVencidos } from "../servicos/relatorios/agendamentos";
import { enviarEmail } from "../servicos/relatorios/envio";

type EventoS3 = Parameters<typeof objetoDoEvento>[0];

export async function insightsContexto(evento: { empresaId?: string } = {}) {
  const empresas = evento?.empresaId ? [evento.empresaId] : await insights.empresasAtivas();
  const resultado = [];
  for (const empresaId of empresas) {
    try {
      resultado.push({ empresaId, ...(await insights.pedir(empresaId)) });
    } catch (e) {
      console.error("Falha ao montar o contexto de", empresaId, e);
      resultado.push({ empresaId, erro: (e as Error).message });
    }
  }
  console.log(JSON.stringify({ insightsContexto: resultado }));
  return resultado;
}

export async function insightsIa(evento: EventoS3) {
  const { bucket, chave } = objetoDoEvento(evento);
  const contexto = await lerJson<ContextoInsights>(chave, bucket);
  const resposta = await gerarInsights(contexto);
  await gravarJson(insights.chaveResposta(contexto.empresaId, contexto.execucaoId), resposta);
  console.log(JSON.stringify({ execucao: contexto.execucaoId, status: resposta.status, provedor: resposta.provedor, erro: resposta.erro }));
  return { execucaoId: contexto.execucaoId, status: resposta.status };
}

export async function insightsGravar(evento: EventoS3) {
  const { bucket, chave } = objetoDoEvento(evento);
  const resposta = await lerJson<RespostaInsights>(chave, bucket);
  await insights.gravar(resposta);
  return { execucaoId: resposta.execucaoId, recomendacoes: resposta.recomendacoes.length };
}

export async function agendamentos() {
  const feitos = await executarVencidos();
  console.log(JSON.stringify({ agendamentos: feitos }));
  return feitos;
}

export async function relatorioEnviar(evento: EventoS3) {
  const { bucket, chave } = objetoDoEvento(evento);
  const pedido = await lerJson<PedidoEnvio>(chave, bucket);
  const resultado = await enviarEmail(pedido);
  await gravarJson(`relatorios/resultados/${pedido.relatorioId}.json`, resultado);
  console.log(JSON.stringify({ relatorio: pedido.relatorioId, envio: resultado.status, erro: resultado.erro }));
  return resultado;
}

export async function relatorioStatus(evento: EventoS3) {
  const { bucket, chave } = objetoDoEvento(evento);
  const resultado = await lerJson<ResultadoEnvio>(chave, bucket);
  await registrarResultadoEnvio(resultado);
  return resultado;
}
