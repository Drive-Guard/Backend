/**
 * Insights com IA (Google Gemini, camada gratuita). Roda FORA da VPC.
 *
 * O Bedrock seria o caminho natural na AWS, mas o AWS Academy Learner Lab
 * nega bedrock:InvokeModel para a LabRole. O Gemini tem camada gratuita e
 * responde em JSON com schema, o que dispensa interpretar texto livre.
 *
 * Qualquer falha (sem chave, cota esgotada, timeout, JSON fora do schema) cai
 * nas regras: a dashboard nunca fica sem insight.
 */

import { gerarPorRegras } from "./regras";
import { schemaResposta, type ConteudoInsights, type ContextoInsights, type RespostaInsights } from "./tipos";

export const VERSAO_PROMPT = "v1-2026-10";

const INSTRUCOES = `Você é analista de segurança de uma transportadora brasileira que usa câmeras
embarcadas para detectar sonolência dos motoristas. Recebe um JSON com métricas da frota nos últimos
7 dias (score de fadiga de 0 a 100; acima de 70 é zona de alerta), o estado atual, as rotas e a base
de acidentes da PRF como comparação nacional.

Responda em português do Brasil, só com o JSON pedido:
- "recomendacoes": de 3 a 6 itens, do mais grave ao menos grave. Cada um com título curto, descrição
  de uma ou duas frases citando os números do contexto, severidade (baixa, media, alta, critica),
  ação sugerida curta e imperativa, e a métrica que embasou o item.
- "resumo": de 4 a 5 frases para o relatório gerencial, cada uma com um número do contexto.
- "motoristas": até 5 insights individuais para os motoristas de maior risco, identificados SÓ pelo
  código (ex.: DRV-1003).

Regras: use apenas números presentes no contexto, nunca invente dados; não cite nomes de pessoas;
não prometa resultado; trate a PRF como referência nacional, não como dado da frota.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    recomendacoes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          titulo: { type: "STRING" },
          descricao: { type: "STRING" },
          severidade: { type: "STRING", enum: ["baixa", "media", "alta", "critica"] },
          acao_sugerida: { type: "STRING" },
          metrica: { type: "STRING" },
        },
        required: ["titulo", "descricao", "severidade", "acao_sugerida", "metrica"],
      },
    },
    resumo: { type: "ARRAY", items: { type: "STRING" } },
    motoristas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          codigo: { type: "STRING" },
          titulo: { type: "STRING" },
          descricao: { type: "STRING" },
          severidade: { type: "STRING", enum: ["baixa", "media", "alta", "critica"] },
        },
        required: ["codigo", "titulo", "descricao", "severidade"],
      },
    },
  },
  required: ["recomendacoes", "resumo", "motoristas"],
};

interface RespostaGemini {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

export async function chamarGemini(
  contexto: ContextoInsights,
  chave: string,
  modelo: string,
  buscar: typeof fetch = fetch,
): Promise<{ conteudo: ConteudoInsights; tokensEntrada: number | null; tokensSaida: number | null }> {
  const controle = new AbortController();
  const tempo = setTimeout(() => controle.abort(), 25_000);
  try {
    const resp = await buscar(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
      method: "POST",
      signal: controle.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCOES }] },
        contents: [{ role: "user", parts: [{ text: `Contexto da frota (JSON):\n${JSON.stringify(contexto)}` }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    const corpo = (await resp.json()) as RespostaGemini;
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${corpo.error?.message ?? "erro"}`);

    const texto = corpo.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!texto) throw new Error(`Gemini sem conteúdo (${corpo.candidates?.[0]?.finishReason ?? "?"})`);
    const conteudo = schemaResposta.parse(JSON.parse(texto));

    // Insight de motorista só vale para código que existe no contexto.
    const codigos = new Set([...contexto.motoristasRisco.map((m) => m.codigo), ...contexto.emRiscoAgora.map((m) => m.codigo)]);
    conteudo.motoristas = conteudo.motoristas.filter((m) => codigos.has(m.codigo));

    return {
      conteudo,
      tokensEntrada: corpo.usageMetadata?.promptTokenCount ?? null,
      tokensSaida: corpo.usageMetadata?.candidatesTokenCount ?? null,
    };
  } finally {
    clearTimeout(tempo);
  }
}

/** Gera os insights do contexto: IA quando possível, regras quando não. */
export async function gerarInsights(
  contexto: ContextoInsights,
  opcoes: { chave?: string; modelo?: string; buscar?: typeof fetch } = {},
): Promise<RespostaInsights> {
  const chave = opcoes.chave ?? process.env.IA_API_KEY ?? "";
  const modelo = opcoes.modelo ?? process.env.IA_MODELO ?? "gemini-2.5-flash";
  const base = { execucaoId: contexto.execucaoId, empresaId: contexto.empresaId, versaoPrompt: VERSAO_PROMPT };

  if (chave && chave !== "nao-configurado") {
    try {
      const r = await chamarGemini(contexto, chave, modelo, opcoes.buscar);
      return { ...base, ...r.conteudo, provedor: "google-gemini", modelo, tokensEntrada: r.tokensEntrada, tokensSaida: r.tokensSaida, status: "ok", erro: null };
    } catch (e) {
      console.warn("IA indisponível, usando regras:", (e as Error).message);
      return { ...base, ...gerarPorRegras(contexto), provedor: "regras", modelo: null, tokensEntrada: null, tokensSaida: null, status: "fallback_regras", erro: (e as Error).message.slice(0, 500) };
    }
  }
  return { ...base, ...gerarPorRegras(contexto), provedor: "regras", modelo: null, tokensEntrada: null, tokensSaida: null, status: "fallback_regras", erro: "IA não configurada" };
}
