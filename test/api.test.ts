/** Rotas de ponta a ponta pelo handler das Lambdas, contra o banco de teste com o seed. */

import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { handler as alertas } from "../src/funcoes/alertas";
import { handler as dashboard } from "../src/funcoes/dashboard";
import { handler as motoristas } from "../src/funcoes/motoristas";
import { handler as relatorios } from "../src/funcoes/relatorios";
import { rotas } from "../src/rotas";
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

  it("toda leitura aceita região e tipo de veículo juntos (sem coluna ambígua)", async () => {
    const handlers: Record<string, (e: never) => Promise<{ statusCode?: number; body?: string }>> = { dashboard, motoristas, alertas, relatorios };
    const leituras = rotas.filter((r) => r.metodo === "GET" && !r.caminho.includes("{") && handlers[r.funcao]);
    expect(leituras.length).toBeGreaterThan(15);
    for (const query of [{ regiao: "Sudeste", tipo_veiculo: "caminhao" }, { regiao: "SP", tipo_veiculo: "onibus" }]) {
      for (const r of leituras) {
        const resp = await handlers[r.funcao](evento(`GET ${r.caminho}`, { papel: "admin", query: { ...query, de: "2026-09-01", ate: "2026-09-20" } }));
        expect(resp.statusCode, `${r.caminho} ${JSON.stringify(query)}: ${resp.body?.slice(0, 200)}`).toBeLessThan(500);
      }
    }
  });

  it("rotas obedecem a região e o tipo, e cada uma leva a motoristas que a fizeram", async () => {
    const todas = corpoJson(await dashboard(evento("GET /dashboard/rotas", { query: { periodo: "30d" } })));
    const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const de = new Date(Date.now() - 29 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    for (const query of [{ regiao: "Sudeste" }, { tipo_veiculo: "onibus" }]) {
      const rotas = corpoJson(await dashboard(evento("GET /dashboard/rotas", { query: { ...query, periodo: "30d" } })));
      expect(rotas.length).toBeLessThan(todas.length);
      const motoristasDoFiltro = corpoJson(await motoristas(evento("GET /motoristas/historico", { query: { ...query, de, ate: hoje } })));
      const feitas = new Set(motoristasDoFiltro.flatMap((m: { rotas: string[] }) => m.rotas));
      for (const r of rotas) expect(feitas, `${r.origemCidade} → ${r.destinoCidade}`).toContain(`${r.origemCidade} → ${r.destinoCidade}`);
    }
  });

  it("rota fora do manifesto dá 404", async () => {
    expect((await dashboard(evento("GET /nao-existe"))).statusCode).toBe(404);
  });
});

describe("motoristas e alertas", () => {
  it("lista ao vivo, detalhe, curva e insights", async () => {
    const lista = corpoJson(await motoristas(evento("GET /motoristas/ao-vivo")));
    expect(lista).toHaveLength(16);
    // A escala do seed é a real: às vezes um turno acabou de fechar e ainda
    // conta como ativo (leitura recente). Pega um com turno em andamento.
    const ativo = lista.find((m: { ativo: boolean; turnoStatus: string }) => m.ativo && m.turnoStatus === "em_andamento");
    expect(ativo).toBeTruthy();
    const detalhe = corpoJson(await motoristas(evento("GET /motoristas/{id}", { params: { id: ativo.motoristaId } })));
    expect(detalhe.codigo).toMatch(/^DRV-/);
    expect(detalhe.ultimos30d.turnos).toBeGreaterThan(0);
    const curva = corpoJson(await motoristas(evento("GET /motoristas/{id}/curva-turno", { params: { id: ativo.motoristaId } })));
    expect(curva.turno.status).toBe("em_andamento");
    expect(curva.pontos.length).toBeGreaterThanOrEqual(12);
    const ins = corpoJson(await motoristas(evento("GET /motoristas/{id}/insights", { params: { id: ativo.motoristaId } })));
    expect(ins.length).toBeGreaterThan(0);
  });

  it("lista ao vivo filtrada bate com os KPIs ao vivo (região e tipo de veículo)", async () => {
    for (const query of [{ regiao: "Sudeste" }, { regiao: "SP" }, { tipo_veiculo: "onibus" }, { regiao: "Sul", tipo_veiculo: "caminhao" }]) {
      const r = await motoristas(evento("GET /motoristas/ao-vivo", { query }));
      expect(r.statusCode, JSON.stringify(query)).toBe(200);
      const lista = corpoJson(r) as { ativo: boolean; risco: string }[];
      const k = corpoJson(await dashboard(evento("GET /dashboard/kpis", { query }))).aoVivo;
      expect(lista).toHaveLength(k.motoristasMonitorados);
      expect(lista.filter((m) => m.ativo)).toHaveLength(k.motoristasAtivos);
      expect(lista.filter((m) => m.ativo && (m.risco === "high" || m.risco === "critical"))).toHaveLength(k.motoristasEmRisco);
    }
  });

  it("turnos anteriores: lista do intervalo e turnos do motorista", async () => {
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const semana = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const lista = corpoJson(await motoristas(evento("GET /motoristas/historico", { query: { de: semana, ate: hoje } })));
    expect(lista.length).toBeGreaterThan(5);
    const m = lista[0];
    expect(m.turnos).toBeGreaterThan(0);
    expect(m.scoreMaximo).toBeGreaterThanOrEqual(m.scoreMedio);
    const turnos = corpoJson(await motoristas(evento("GET /motoristas/{id}/turnos", { params: { id: m.motoristaId }, query: { de: semana, ate: hoje } })));
    expect(turnos).toHaveLength(m.turnos);
    expect(turnos[0].turnoId).toBe(m.ultimoTurnoId);
    // Rotas do intervalo, as mesmas da lista de turnos.
    const rotasDosTurnos = new Set(turnos.filter((t: { origem: string | null }) => t.origem).map((t: { origem: string; destino: string }) => `${t.origem} → ${t.destino}`));
    expect(new Set(m.rotas)).toEqual(rotasDosTurnos);
    // A curva aceita o turno escolhido.
    const curva = corpoJson(await motoristas(evento("GET /motoristas/{id}/curva-turno", { params: { id: m.motoristaId }, query: { turno_id: turnos.at(-1).turnoId } })));
    expect(curva.turno.turnoId).toBe(turnos.at(-1).turnoId);
  });

  it("alertas recentes mostram a resposta da central e o resumo dos graves", async () => {
    const sql = db();
    // Alerta grave novo, aberto, de um motorista da demo.
    const [grave] = await sql`
      INSERT INTO silver.alertas (motorista_id, disparado_em, tipo, gravidade, score_fadiga, mensagem)
      SELECT id, now() - interval '10 minutes', 'microssono', 'critica', 88, 'teste de resposta'
        FROM silver.motoristas WHERE codigo = 'DRV-1002'
      RETURNING id, motorista_id`;
    const [outro] = await sql`
      INSERT INTO silver.alertas (motorista_id, disparado_em, tipo, gravidade, score_fadiga, mensagem)
      SELECT id, now() - interval '12 minutes', 'bocejo_excessivo', 'alta', 75, 'teste de falso alarme'
        FROM silver.motoristas WHERE codigo = 'DRV-1004'
      RETURNING id`;
    const r = await motoristas(evento("POST /motoristas/{id}/acoes", { params: { id: grave.motorista_id }, corpo: { tipo: "contato_telefonico", alertaId: grave.id } }));
    expect(r.statusCode).toBe(201);

    const t = corpoJson(await dashboard(evento("GET /dashboard/alertas-tempo-real", { query: { horas: "24", gravidade: "graves" } })));
    expect(t.respostas.graves).toBeGreaterThan(0);
    expect(t.respostas.atendidos).toBeGreaterThan(0);
    const ev = t.eventos.find((e: { id: string }) => e.id === grave.id);
    expect(ev.resposta).toMatchObject({ tipo: "contato_telefonico" });

    // Falso alarme sai da conta de atendidos e aparece como tal.
    expect((await alertas(evento("PATCH /alertas/{id}", { params: { id: outro.id }, corpo: { status: "descartado" } }))).statusCode).toBe(200);
    const depois = corpoJson(await dashboard(evento("GET /dashboard/alertas-tempo-real", { query: { horas: "24" } })));
    const descartado = depois.eventos.find((e: { id: string }) => e.id === outro.id);
    expect(descartado.resposta.tipo).toBe("falso_alarme");
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
    // Sem gravidade = ocorrência sem acidente (quase-acidente).
    const r = await motoristas(evento("POST /motoristas/{id}/ocorrencias", { params: { id: lista[0].motoristaId }, corpo: { descricao: "Motorista relatou sonolência e parou no posto", relacionadoSonolencia: true } }));
    expect(r.statusCode).toBe(201);
    const det = corpoJson(await motoristas(evento("GET /motoristas/{id}", { params: { id: lista[0].motoristaId } })));
    expect(det.ocorrencias[0]).toMatchObject({ relacionadoSonolencia: true, gravidade: null, descricao: "Motorista relatou sonolência e parou no posto" });
    const titulos = async () =>
      corpoJson(await motoristas(evento("GET /motoristas/{id}/insights", { params: { id: lista[0].motoristaId } }))).map((i: { titulo: string }) => i.titulo);
    const antes = await titulos();
    expect(antes.includes("Quase acidente por sono nos últimos 30 dias") || antes.includes("Acidente por sono nos últimos 90 dias")).toBe(true);

    // Com gravidade = acidente: vira o insight crítico.
    await motoristas(evento("POST /motoristas/{id}/ocorrencias", { params: { id: lista[0].motoristaId }, corpo: { descricao: "Saída de pista sem feridos", gravidade: "sem_vitimas", relacionadoSonolencia: true } }));
    expect(await titulos()).toContain("Acidente por sono nos últimos 90 dias");

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
