/**
 * Formatos trocados entre as Lambdas de insights (pelo S3).
 *
 * O contexto é pseudonimizado: motoristas aparecem só pelo código interno
 * (DRV-1000), veículos pelo código da câmera; nenhum nome, CPF ou placa sai
 * do banco para o provedor de IA.
 */

import { z } from "zod";

export interface ContextoInsights {
  versao: 1;
  execucaoId: string;
  empresaId: string;
  geradoEm: string;
  periodo: { de: string; ate: string; anteriorDe: string; anteriorAte: string };
  frota: {
    motoristasMonitorados: number;
    motoristasAtivosAgora: number;
    emRiscoAgora: number;
    fadigaMediaAgora: number | null;
    fadigaMedia7d: number | null;
    fadigaMedia7dAnterior: number | null;
    variacaoFadigaPercentual: number | null;
    alertas7d: number;
    alertas7dAnterior: number;
    alertasGraves7d: number;
    alertasAbertosGraves: number;
    horasDirigidas7d: number;
    turnos7d: number;
  };
  horarioCritico: { inicio: string; fim: string; percentual: number | null; madrugadaPercentual: number | null } | null;
  fadigaPorHoraDirecao: { hora: string; fadiga: number | null; alertas: number }[];
  porTipoVeiculo: { tipo: string; fadiga: number | null; alertas: number }[];
  porRegiao: { regiao: string; fadiga: number | null; alertas: number }[];
  tiposAlerta: { tipo: string; total: number }[];
  motoristasRisco: {
    codigo: string;
    fadigaMedia30d: number | null;
    alertas30d: number;
    alertasGraves30d: number;
    horasDirigidas30d: number | null;
    nivel: string;
    agora: { score: number | null; horasTurno: number | null } | null;
  }[];
  emRiscoAgora: { codigo: string; score: number; horasTurno: number | null }[];
  rotas: { rota: string; fadiga: number | null; alertas: number; tendencia: number | null; prfAcidentesSono: number | null }[];
  prf: { janelaAte: string; acidentesSonoPesados: number; madrugadaPercentual: number | null } | null;
  roi: { disponivel: boolean; acidentesEvitadosAno: number | null; custoEvitadoAno: number | null; reducaoPercentual: number | null } | null;
  atendimento: { graves30d: number; atendidos30d: number; percentual: number | null };
  /** Acidentes da própria frota (não os da PRF) nos últimos 12 meses. */
  acidentesFrota: {
    total12m: number;
    porSono12m: number;
    ultimoPorSono: { codigo: string | null; quando: string; horaLocal: string; descricao: string | null } | null;
  };
}

export const SEVERIDADES = ["baixa", "media", "alta", "critica"] as const;

export const schemaInsightMotorista = z.object({
  codigo: z.string().min(1).max(40),
  titulo: z.string().min(3).max(120),
  descricao: z.string().min(3).max(600),
  severidade: z.enum(SEVERIDADES),
});

export const schemaResposta = z.object({
  recomendacoes: z
    .array(
      z.object({
        titulo: z.string().min(3).max(120),
        descricao: z.string().min(3).max(600),
        severidade: z.enum(SEVERIDADES),
        acao_sugerida: z.string().min(2).max(160),
        metrica: z.string().max(200).optional().default(""),
      }),
    )
    .min(1)
    .max(8),
  resumo: z.array(z.string().min(3).max(400)).min(1).max(8),
  // Um insight individual malformado é descartado, não derruba a resposta.
  motoristas: z
    .array(z.unknown())
    .max(20)
    .default([])
    .transform((itens) =>
      itens.flatMap((i) => {
        const r = schemaInsightMotorista.safeParse(i);
        return r.success ? [r.data] : [];
      }),
    ),
});

export type ConteudoInsights = z.infer<typeof schemaResposta>;

export interface RespostaInsights extends ConteudoInsights {
  execucaoId: string;
  empresaId: string;
  provedor: string;
  modelo: string | null;
  versaoPrompt: string;
  tokensEntrada: number | null;
  tokensSaida: number | null;
  status: "ok" | "fallback_regras";
  erro: string | null;
}
