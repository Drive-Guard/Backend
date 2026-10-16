/** ROI, insights (regras, IA com fetch simulado, cadeia completa) e usuários. */

import { afterAll, describe, expect, it } from "vitest";
import { aoGravarLocal } from "../src/lib/arquivos";
import { db } from "../src/lib/db";
import { handler as dashboard } from "../src/funcoes/dashboard";
import { handler as usuarios } from "../src/funcoes/usuarios";
import * as workers from "../src/funcoes/workers";
import * as insights from "../src/servicos/insights";
import { montarContexto } from "../src/servicos/insights/contexto";
import { gerarInsights } from "../src/servicos/insights/ia";
import { gerarPorRegras } from "../src/servicos/insights/regras";
import { schemaResposta } from "../src/servicos/insights/tipos";
import * as roi from "../src/servicos/roi";
import { corpoJson, EMPRESA_DEMO, evento } from "./ajuda";

afterAll(async () => {
  await db().end();
});

describe("ROI", () => {
  it("segue a fórmula com os parâmetros e a PRF", async () => {
    const r = await roi.calcular(EMPRESA_DEMO);
    expect(r.disponivel).toBe(true);
    // 16 câmeras do seed (outros testes podem instalar mais) numa frota de 20.
    expect(r.cobertura.frotaTotal).toBe(20);
    expect(r.cobertura.veiculosComCamera).toBeGreaterThanOrEqual(16);
    const cobertura = r.cobertura.veiculosComCamera / 20;
    expect(r.cobertura.fracao).toBeCloseTo(cobertura, 3);
    const p = Object.fromEntries(r.parametros.map((x) => [x.chave, x.valor]));
    const c = r.cenarios.conservador;
    expect(c.acidentesPorSono).toBeCloseTo(p.acidentes_ano_frota! * p.fracao_sono_conservador!, 2);
    expect(c.acidentesEvitados).toBeCloseTo(c.acidentesPorSono * p.eficacia_alerta! * cobertura, 2);
    // As saídas vêm arredondadas; a conta exata usa os parâmetros.
    const evitados = p.acidentes_ano_frota! * p.fracao_sono_conservador! * p.eficacia_alerta! * cobertura;
    expect(Math.abs(c.custoEvitado - evitados * r.custoMedioPorAcidente)).toBeLessThan(5);
    expect(c.horasParadaEvitadas).toBeCloseTo(evitados * p.horas_parada_por_acidente!, 1);
    expect(r.cenarios.realista.custoEvitado).toBeGreaterThan(c.custoEvitado);
    expect(r.reducaoAcidentesSonoPercentual).toBe(Math.round(p.eficacia_alerta! * cobertura * 100));
    expect(r.proporcoesGravidade.fonte).toMatch(/PRF/);
  });
});

describe("insights", () => {
  it("regras produzem conteúdo válido no schema da IA", async () => {
    const ctx = await montarContexto(EMPRESA_DEMO);
    expect(JSON.stringify(ctx)).not.toMatch(/Carlos Silva|DGD[A-Z]\d{2}/); // sem nome nem placa
    const r = gerarPorRegras(ctx);
    expect(() => schemaResposta.parse(r)).not.toThrow();
    expect(r.recomendacoes.length).toBeGreaterThan(0);
  });

  it("IA com resposta válida; motorista inventado é descartado", async () => {
    const ctx = await montarContexto(EMPRESA_DEMO);
    const codigo = ctx.motoristasRisco[0]?.codigo ?? "DRV-1000";
    const falsoFetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            recomendacoes: [{ titulo: "Revisar escala noturna", descricao: "61% dos alertas entre 1h e 3h.", severidade: "critica", acao_sugerida: "Revisar escala", metrica: "horario_critico" }],
            resumo: ["A fadiga caiu 5% na semana."],
            motoristas: [{ codigo, titulo: "Fadiga alta", descricao: "Score médio 70.", severidade: "alta" }, { codigo: "DRV-9999", titulo: "Motorista inventado", descricao: "não existe no contexto", severidade: "baixa" }, { codigo: "DRV-1001", titulo: "x" }],
          }) }] } }],
          usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
        }),
        { status: 200 },
      );
    const r = await gerarInsights(ctx, { chave: "chave-teste", buscar: falsoFetch as never });
    expect(r).toMatchObject({ status: "ok", provedor: "google-gemini", tokensEntrada: 1200 });
    expect(r.motoristas.map((m) => m.codigo)).toEqual([codigo]);
  });

  it("insights seguem o período do filtro da dashboard", async () => {
    const ctx7 = await montarContexto(EMPRESA_DEMO, undefined, { periodo: "7d" });
    const ctx90 = await montarContexto(EMPRESA_DEMO, undefined, { periodo: "90d" });
    expect(ctx7.periodo).toMatchObject({ dias: 7, rotulo: "nos últimos 7 dias" });
    expect(ctx90.periodo.dias).toBe(90);
    expect(ctx90.frota.turnosPeriodo).toBeGreaterThan(ctx7.frota.turnosPeriodo);
    expect(ctx90.acidentesFrota.total).toBeGreaterThanOrEqual(ctx7.acidentesFrota.total);
    const custom = await montarContexto(EMPRESA_DEMO, undefined, { de: "2026-01-01", ate: "2026-01-31" });
    expect(custom.periodo).toMatchObject({ dias: 31, rotulo: "de 01/01/2026 a 31/01/2026" });
  });

  it("IA indisponível cai nas regras", async () => {
    const ctx = await montarContexto(EMPRESA_DEMO);
    const r = await gerarInsights(ctx, { chave: "chave-teste", buscar: (async () => new Response('{"error":{"message":"quota"}}', { status: 429 })) as never });
    expect(r.status).toBe("fallback_regras");
    expect(r.erro).toMatch(/429/);
    expect(r.recomendacoes.length).toBeGreaterThan(0);
  });

  it("cadeia completa: pedido -> IA/regras -> gravação -> dashboard", async () => {
    aoGravarLocal(async (chave) => {
      const ev = { detail: { bucket: { name: "local" }, object: { key: chave } } } as never;
      if (chave.startsWith("insights/contextos/")) await workers.insightsIa(ev);
      if (chave.startsWith("insights/respostas/")) await workers.insightsGravar(ev);
    });
    const pedido = await dashboard(evento("POST /dashboard/insights/gerar"));
    expect(pedido.statusCode).toBe(202);
    const { execucaoId } = corpoJson(pedido);

    const ultimos = await insights.ultimos(EMPRESA_DEMO);
    expect(ultimos.execucaoId).toBe(execucaoId);
    expect(ultimos.origem).toBe("regras");
    expect(ultimos.recomendacoes.length).toBeGreaterThan(0);
    expect(ultimos.resumo.length).toBeGreaterThan(0);

    const [e] = await db()`SELECT status, concluido_em IS NOT NULL AS concluida FROM silver.insights_execucoes WHERE id = ${execucaoId}`;
    expect(e).toEqual({ status: "fallback_regras", concluida: true });

    // A rodada é do período padrão (30 dias): outro período não a reaproveita.
    const outro = await insights.ultimos(EMPRESA_DEMO, { periodo: "90d" });
    expect(outro.execucaoId).toBeNull();
    expect(outro.periodo.dias).toBe(90);
    expect((await dashboard(evento("POST /dashboard/insights/gerar", { papel: "operador" }))).statusCode).toBe(403);
  });
});

describe("usuários (provedor em memória)", () => {
  it("admin cria, lista, troca papel; não se rebaixa", async () => {
    const criado = await usuarios(evento("POST /usuarios", { papel: "admin", corpo: { email: "Nova.Gestora@Empresa.com", nome: "Nova Gestora", papel: "gestor" } }));
    expect(criado.statusCode).toBe(201);
    const { usuario, senhaTemporaria } = corpoJson(criado);
    expect(usuario.email).toBe("nova.gestora@empresa.com");
    expect(senhaTemporaria).toMatch(/[A-Z]/);
    expect(senhaTemporaria).toMatch(/\d/);

    const lista = corpoJson(await usuarios(evento("GET /usuarios", { papel: "admin" })));
    expect(lista.map((u: { email: string }) => u.email)).toContain("nova.gestora@empresa.com");

    const mudou = corpoJson(await usuarios(evento("PATCH /usuarios/{username}", { papel: "admin", params: { username: usuario.username }, corpo: { papel: "operador" } })));
    expect(mudou.papel).toBe("operador");
    expect((await usuarios(evento("GET /usuarios", { papel: "gestor" }))).statusCode).toBe(403);

    // A outra empresa não enxerga.
    const outra = corpoJson(await usuarios(evento("GET /usuarios", { papel: "admin", empresaId: "00000000-0000-4000-8000-0000000000ff" })));
    expect(outra).toHaveLength(0);
    expect((await usuarios(evento("DELETE /usuarios/{username}", { papel: "admin", params: { username: usuario.username } }))).statusCode).toBe(204);
  });
});
