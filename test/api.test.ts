/** Rotas de ponta a ponta pelo handler das Lambdas, contra o banco de teste com o seed. */

import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { handler as alertas } from "../src/funcoes/alertas";
import { handler as dashboard } from "../src/funcoes/dashboard";
import { handler as motoristas } from "../src/funcoes/motoristas";
import { corpoJson, evento } from "./ajuda";

afterAll(async () => {
  await db().end();
});

describe("dashboard", () => {
  it("/me devolve papel e empresa", async () => {
    const r = await dashboard(evento("GET /me", { papel: "admin" }));
    expect(r.statusCode).toBe(200);
    expect(corpoJson(r)).toMatchObject({ papel: "admin", empresa: { nome: "DriveGuard Demo", frotaTotal: 20 } });
  });

  it("KPIs com período anterior para comparar", async () => {
    const r = corpoJson(await dashboard(evento("GET /dashboard/kpis", { query: { periodo: "30d" } })));
    expect(r.aoVivo.motoristasMonitorados).toBe(16);
    expect(r.aoVivo.motoristasAtivos).toBeGreaterThan(0);
    expect(r.periodo.fadigaMedia).toBeGreaterThan(0);
    expect(r.periodo.fadigaMediaAnterior).toBeGreaterThan(0); // 8 semanas de histórico no seed
    expect(r.horarioCritico.inicio).toMatch(/^\d{2}:00$/);
  });

  it("filtro de região e tipo de veículo restringe os KPIs", async () => {
    const todos = corpoJson(await dashboard(evento("GET /dashboard/kpis")));
    const onibus = corpoJson(await dashboard(evento("GET /dashboard/kpis", { query: { tipo_veiculo: "onibus" } })));
    expect(onibus.aoVivo.motoristasMonitorados).toBeLessThan(todos.aoVivo.motoristasMonitorados);
    const sul = await dashboard(evento("GET /dashboard/kpis", { query: { regiao: "Sul" } }));
    expect(sul.statusCode).toBe(200);
    const invalida = await dashboard(evento("GET /dashboard/kpis", { query: { regiao: "Marte" } }));
    expect(invalida.statusCode).toBe(400);
  });

  it("tendência do turno sobe com as horas de direção", async () => {
    const r = corpoJson(await dashboard(evento("GET /dashboard/tendencia-turno", { query: { periodo: "30d" } })));
    expect(r.pontos).toHaveLength(12);
    expect(r.pontos[0].fadiga).toBeLessThan(r.pontos[7].fadiga);
    expect(r.resumo.pico.hora).toMatch(/h$/);
  });

  it("heatmap: 6 faixas x 7 dias por padrão; intervalo do calendário", async () => {
    const r = corpoJson(await dashboard(evento("GET /dashboard/heatmap")));
    expect(r.faixas).toHaveLength(6);
    expect(r.dias).toHaveLength(7);
    expect(r.valores.every((l: unknown[]) => l.length === 7)).toBe(true);
    const intervalo = corpoJson(await dashboard(evento("GET /dashboard/heatmap", { query: { de: "2026-10-01", ate: "2026-10-03" } })));
    expect(intervalo.dias).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const longo = await dashboard(evento("GET /dashboard/heatmap", { query: { de: "2026-01-01", ate: "2026-03-01" } }));
    expect(longo.statusCode).toBe(400);
  });

  it("rotas ordenadas pela fadiga, com o cruzamento da PRF", async () => {
    const r = corpoJson(await dashboard(evento("GET /dashboard/rotas")));
    expect(r.length).toBeGreaterThan(3);
    const fadigas = r.map((x: { fadiga: number }) => x.fadiga);
    expect([...fadigas].sort((a, b) => b - a)).toEqual(fadigas);
    const dutra = r.find((x: { nome: string }) => x.nome === "Via Dutra");
    expect(dutra.prf.acidentes).toBeGreaterThan(0); // BR-116/SP na amostra
  });

  it("base da PRF identificada e só com veículos pesados por padrão", async () => {
    const resumo = corpoJson(await dashboard(evento("GET /dashboard/prf/resumo")));
    expect(resumo.carregada).toBe(true);
    expect(resumo.fonte).toMatch(/PRF/);
    expect(resumo.recorte.veiculosPesados).toBe(true);
    const todos = corpoJson(await dashboard(evento("GET /dashboard/prf/resumo", { query: { pesados: "false" } })));
    expect(todos.acidentes).toBeGreaterThan(resumo.acidentes);
    const causas = corpoJson(await dashboard(evento("GET /dashboard/prf/causas")));
    expect(causas.causas.some((c: { ligadaASono: boolean }) => c.ligadaASono)).toBe(true);
    const mapa = corpoJson(await dashboard(evento("GET /dashboard/prf/mapa")));
    expect(mapa.cidades[0]).toHaveProperty("latitude");
  });

  it("ROI: gestor vê, operador não", async () => {
    const r = await dashboard(evento("GET /dashboard/roi"));
    expect(r.statusCode).toBe(200);
    expect(corpoJson(r).disponivel).toBe(true);
    expect((await dashboard(evento("GET /dashboard/roi", { papel: "operador" }))).statusCode).toBe(403);
  });

  it("exportação CSV com BOM e separador ;", async () => {
    const r = await dashboard(evento("GET /dashboard/exportar"));
    expect(r.headers?.["Content-Type"]).toMatch(/text\/csv/);
    expect(r.body!.startsWith("﻿Código;Motorista")).toBe(true);
  });

  it("rota fora do manifesto dá 404", async () => {
    expect((await dashboard(evento("GET /nao-existe"))).statusCode).toBe(404);
  });
});

describe("motoristas e alertas", () => {
  it("lista ao vivo, detalhe, curva e insights", async () => {
    const lista = corpoJson(await motoristas(evento("GET /motoristas/ao-vivo")));
    expect(lista).toHaveLength(16);
    const ativo = lista.find((m: { ativo: boolean }) => m.ativo);
    const detalhe = corpoJson(await motoristas(evento("GET /motoristas/{id}", { params: { id: ativo.motoristaId } })));
    expect(detalhe.codigo).toMatch(/^DRV-/);
    expect(detalhe.ultimos30d.turnos).toBeGreaterThan(0);
    const curva = corpoJson(await motoristas(evento("GET /motoristas/{id}/curva-turno", { params: { id: ativo.motoristaId } })));
    expect(curva.turno.status).toBe("em_andamento");
    expect(curva.pontos.length).toBeGreaterThanOrEqual(12);
    const ins = corpoJson(await motoristas(evento("GET /motoristas/{id}/insights", { params: { id: ativo.motoristaId } })));
    expect(ins.length).toBeGreaterThan(0);
  });

  it("uma empresa nunca vê a frota da outra", async () => {
    const OUTRA = "00000000-0000-4000-8000-0000000000ff";
    const sql = db();
    await sql`INSERT INTO silver.empresas (id, cnpj_hash, razao_social) VALUES (${OUTRA}, 'outra-empresa', 'Outra Transportes')
              ON CONFLICT (id) DO NOTHING`;
    const lista = corpoJson(await motoristas(evento("GET /motoristas/ao-vivo")));
    const r = await motoristas(evento("GET /motoristas/{id}", { params: { id: lista[0].motoristaId }, empresaId: OUTRA }));
    expect(r.statusCode).toBe(404);
    expect(corpoJson(await motoristas(evento("GET /motoristas/ao-vivo", { empresaId: OUTRA })))).toHaveLength(0);
    expect(corpoJson(await dashboard(evento("GET /dashboard/kpis", { empresaId: OUTRA }))).aoVivo.motoristasMonitorados).toBe(0);
    // Usuário cuja empresa não existe é recusado no registro.
    const fantasma = await motoristas(evento("GET /motoristas/ao-vivo", { empresaId: "00000000-0000-4000-8000-0000000000fe" }));
    expect(fantasma.statusCode).toBe(403);
  });

  it("solicitar pausa atende o alerta aberto mais grave", async () => {
    const sql = db();
    const [alvo] = await sql`
      SELECT a.motorista_id, a.id FROM silver.alertas a
       WHERE a.status = 'aberto' AND a.disparado_em >= now() - interval '2 hours'
       ORDER BY (a.gravidade IN ('alta', 'critica')) DESC, a.disparado_em DESC LIMIT 1
    `;
    if (!alvo) return; // seed sem alerta aberto recente: nada a verificar
    const r = await motoristas(evento("POST /motoristas/{id}/acoes", { params: { id: alvo.motorista_id }, corpo: { tipo: "pausa_obrigatoria" } }));
    expect(r.statusCode).toBe(201);
    const [a] = await sql`SELECT status::text AS status, reconhecido_por FROM silver.alertas WHERE id = ${corpoJson(r).alerta_id}`;
    expect(a.status).toBe("reconhecido");
    expect(a.reconhecido_por).toBeTruthy();
  });

  it("ocorrência interna com acento e validação em português", async () => {
    const lista = corpoJson(await motoristas(evento("GET /motoristas/ao-vivo")));
    const r = await motoristas(evento("POST /motoristas/{id}/ocorrencias", { params: { id: lista[0].motoristaId }, corpo: { descricao: "Motorista relatou sonolência e parou no posto", relacionadoSonolencia: true } }));
    expect(r.statusCode).toBe(201);

    // Aparece no detalhe do motorista e vira insight (acidente por sono recente).
    const det = corpoJson(await motoristas(evento("GET /motoristas/{id}", { params: { id: lista[0].motoristaId } })));
    expect(det.ocorrencias[0]).toMatchObject({ relacionadoSonolencia: true, descricao: "Motorista relatou sonolência e parou no posto" });
    const ins = corpoJson(await motoristas(evento("GET /motoristas/{id}/insights", { params: { id: lista[0].motoristaId } })));
    expect(ins.some((i: { titulo: string }) => i.titulo === "Acidente por sono nos últimos 90 dias")).toBe(true);

    const ruim = await motoristas(evento("POST /motoristas/{id}/acoes", { params: { id: lista[0].motoristaId }, corpo: { tipo: "xyz" } }));
    expect(ruim.statusCode).toBe(400);
    expect(corpoJson(ruim).detalhes[0].mensagem).toMatch(/[Oo]pção|inválid/);
  });

  it("alertas: lista e reconhece", async () => {
    const lista = corpoJson(await alertas(evento("GET /alertas", { query: { horas: "720", limite: "5" } })));
    expect(lista.length).toBeGreaterThan(0);
    const r = await alertas(evento("PATCH /alertas/{id}", { params: { id: lista[0].id }, corpo: { status: "resolvido" } }));
    expect(corpoJson(r).status).toBe("resolvido");
  });
});
