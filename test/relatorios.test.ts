import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { aoGravarLocal } from "../src/lib/arquivos";
import { db } from "../src/lib/db";
import { handler as relatorios } from "../src/funcoes/relatorios";
import * as workers from "../src/funcoes/workers";
import { executarVencidos } from "../src/servicos/relatorios/agendamentos";
import { corpoJson, evento } from "./ajuda";

afterAll(async () => {
  await db().end();
});

const arquivo = (chave: string) => readFileSync(join(process.env.ARQUIVOS_DIR!, chave));

describe("aba Relatórios", () => {
  it("resumo com KPIs, série, distribuição e resumo inteligente", async () => {
    const r = corpoJson(await relatorios(evento("GET /relatorios/resumo", { query: { periodo: "30d" } })));
    expect(r.kpis.eventos).toBeGreaterThan(0);
    expect(r.kpis.motoristasAnalisados).toBeGreaterThan(0);
    expect(r.kpis.economiaEstimada).toBeGreaterThan(0);
    expect(r.serieFadiga).toHaveLength(30);
    expect(r.distribuicaoAlertas[0].rotulo).toBeTruthy();
    expect(r.resumoInteligente.frases.length).toBeGreaterThanOrEqual(3);
  });

  it("filtros de risco, veículo e faixa horária", async () => {
    const tudo = corpoJson(await relatorios(evento("GET /relatorios/resumo", { query: { periodo: "30d" } })));
    const madrugada = corpoJson(await relatorios(evento("GET /relatorios/resumo", { query: { periodo: "30d", faixa_horaria: "madrugada" } })));
    expect(madrugada.kpis.eventos).toBeLessThanOrEqual(tudo.kpis.eventos);
    const criticos = await relatorios(evento("GET /relatorios/resumo", { query: { periodo: "30d", risco: "critico" } }));
    expect(criticos.statusCode).toBe(200);
  });
});

describe("geração", () => {
  for (const tipo of ["executivo", "operacional", "motoristas", "frota", "alertas"]) {
    for (const formato of ["pdf", "xlsx", "csv"]) {
      it(`${tipo} em ${formato}`, async () => {
        const r = await relatorios(evento("POST /relatorios", { corpo: { tipo, formato, filtros: { periodo: "30d" } } }));
        expect(r.statusCode, r.body).toBe(201);
        const g = corpoJson(r);
        expect(g.status).toBe("pronto");
        const chave = `relatorios/arquivos/00000000-0000-4000-8000-000000000001/${g.id}.${formato}`;
        const bytes = arquivo(chave);
        if (formato === "pdf") expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
        if (formato === "xlsx") expect(bytes.subarray(0, 2).toString()).toBe("PK");
        if (formato === "csv") expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(bytes.length).toBeGreaterThan(300);
      });
    }
  }

  it("histórico e link de download", async () => {
    const lista = corpoJson(await relatorios(evento("GET /relatorios")));
    expect(lista.length).toBeGreaterThan(0);
    const d = corpoJson(await relatorios(evento("GET /relatorios/{id}/download", { params: { id: lista[0].id } })));
    expect(d.url).toContain("/arquivos/relatorios/arquivos/");
  });

  it("envio sem SES: fica registrado como falho, com o relatório disponível", async () => {
    // Localmente o servidor de dev faz o papel do EventBridge; aqui, o teste.
    aoGravarLocal(async (chave) => {
      const ev = { detail: { bucket: { name: "local" }, object: { key: chave } } } as never;
      if (chave.startsWith("relatorios/envios/")) await workers.relatorioEnviar(ev);
      if (chave.startsWith("relatorios/resultados/")) await workers.relatorioStatus(ev);
    });
    const r = corpoJson(await relatorios(evento("POST /relatorios", { corpo: { tipo: "executivo", formato: "pdf", destinatarios: ["gestor@empresa.com"] } })));
    expect(r.envio).toBe("pendente");
    const sql = db();
    const [g] = await sql`SELECT status::text AS status, envio::text AS envio, envio_erro FROM silver.relatorios_gerados WHERE id = ${r.id}`;
    expect(g).toMatchObject({ status: "pronto", envio: "falhou" });
    expect(g.envio_erro).toMatch(/dashboard/);
    expect(existsSync(join(process.env.ARQUIVOS_DIR!, `relatorios/envios/${r.id}.json`))).toBe(true);
  });

  it("pedido inválido", async () => {
    expect((await relatorios(evento("POST /relatorios", { corpo: { tipo: "outro", formato: "pdf" } }))).statusCode).toBe(400);
    expect((await relatorios(evento("POST /relatorios", { corpo: { tipo: "executivo", formato: "pdf", destinatarios: ["nao-e-email"] } }))).statusCode).toBe(400);
  });
});

describe("agendamentos", () => {
  it("CRUD e execução do vencido", async () => {
    const criado = await relatorios(evento("POST /relatorios/agendamentos", {
      corpo: { tipo: "alertas", formato: "csv", frequencia: "semanal", horario: "08:00", diaSemana: 1, destinatarios: ["frota@empresa.com"] },
    }));
    expect(criado.statusCode).toBe(201);
    const a = corpoJson(criado);
    expect(new Date(a.proximaExecucao).getTime()).toBeGreaterThan(Date.now());

    const semDia = await relatorios(evento("POST /relatorios/agendamentos", {
      corpo: { tipo: "alertas", formato: "csv", frequencia: "semanal", horario: "08:00", destinatarios: ["frota@empresa.com"] },
    }));
    expect(semDia.statusCode).toBe(400);

    // Força o vencimento e roda o trabalho agendado.
    const sql = db();
    await sql`UPDATE silver.agendamentos_relatorio SET proxima_execucao = now() - interval '1 minute' WHERE id = ${a.id}`;
    const feitos = await executarVencidos();
    expect(feitos.find((f) => f.id === a.id)?.relatorio).toBeTruthy();
    const [depois] = await sql`SELECT proxima_execucao > now() AS futura, ultima_execucao IS NOT NULL AS rodou FROM silver.agendamentos_relatorio WHERE id = ${a.id}`;
    expect(depois).toEqual({ futura: true, rodou: true });

    const atualizado = await relatorios(evento("PUT /relatorios/agendamentos/{id}", {
      params: { id: a.id },
      corpo: { tipo: "executivo", formato: "pdf", frequencia: "mensal", horario: "07:00", diaMes: 1, destinatarios: ["diretoria@empresa.com"], ativo: false },
    }));
    expect(corpoJson(atualizado)).toMatchObject({ frequencia: "mensal", diaMes: 1, ativo: false });
    expect((await relatorios(evento("DELETE /relatorios/agendamentos/{id}", { params: { id: a.id } }))).statusCode).toBe(204);
  });
});
