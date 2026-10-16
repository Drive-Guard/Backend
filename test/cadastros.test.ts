import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { handler as cadastros } from "../src/funcoes/cadastros";
import * as roi from "../src/servicos/roi";
import { corpoJson, EMPRESA_DEMO, evento } from "./ajuda";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

afterAll(async () => {
  await db().end();
});

describe("motoristas", () => {
  it("cadastro pelo código completa o motorista que a telemetria já criou", async () => {
    const sql = db();
    const [prov] = await sql`
      INSERT INTO silver.empresas (cnpj_hash, razao_social) VALUES ('00000000000000000000000000000000', 'Empresa nao identificada')
      ON CONFLICT (cnpj_hash) DO UPDATE SET razao_social = EXCLUDED.razao_social RETURNING id`;
    const [orfao] = await sql`
      INSERT INTO silver.motoristas (empresa_id, motorista_hash, nome_exibicao)
      VALUES (${prov.id}, ${sha("DRV-7777")}, 'Motorista não cadastrado (abc123)') RETURNING id`;

    const r = await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "DRV-7777", nome: "Marta Teixeira", idade: 41, regiaoUf: "sp" } }));
    expect(r.statusCode).toBe(201);
    expect(corpoJson(r)).toMatchObject({ id: orfao.id, completouTelemetria: true });
    const [m] = await sql`SELECT empresa_id, codigo, nome_exibicao, regiao_uf FROM silver.motoristas WHERE id = ${orfao.id}`;
    expect(m).toMatchObject({ empresa_id: EMPRESA_DEMO, codigo: "DRV-7777", nome_exibicao: "Marta Teixeira", regiao_uf: "SP" });

    const repetido = await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "DRV-7777", nome: "Outra" } }));
    expect(repetido.statusCode).toBe(409);
  });

  it("valida os campos", async () => {
    const r = await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "x", nome: "" } }));
    expect(r.statusCode).toBe(400);
    expect(corpoJson(r).detalhes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("veículos e câmeras", () => {
  it("troca de câmera encerra os vínculos antigos e assume a câmera pendente", async () => {
    const sql = db();
    const v1 = corpoJson(await cadastros(evento("POST /cadastros/veiculos", { corpo: { placa: "tst-1a11", tipo: "caminhao" } })));
    const v2 = corpoJson(await cadastros(evento("POST /cadastros/veiculos", { corpo: { placa: "TST2B22", tipo: "onibus" } })));
    expect(v1.placa).toBe("TST1A11");
    expect((await cadastros(evento("POST /cadastros/veiculos", { corpo: { placa: "TST1A11", tipo: "van" } }))).statusCode).toBe(409);

    // Câmera que mandou dado antes de ser cadastrada: pendente, sem empresa.
    const [cam] = await sql`INSERT INTO silver.dispositivos (device_id, status) VALUES ('dg-edge-teste', 'pendente') RETURNING id`;
    const lista = corpoJson(await cadastros(evento("GET /cadastros/dispositivos")));
    expect(lista.find((d: { id: string }) => d.id === cam.id).pendente).toBe(true);

    const a = await cadastros(evento("POST /cadastros/dispositivos/{id}/vincular", { params: { id: cam.id }, corpo: { veiculoId: v1.id } }));
    expect(corpoJson(a).alterado).toBe(true);
    const b = await cadastros(evento("POST /cadastros/dispositivos/{id}/vincular", { params: { id: cam.id }, corpo: { veiculoId: v2.id, motivo: "caminhão na oficina" } }));
    expect(corpoJson(b).alterado).toBe(true);

    const hist = corpoJson(await cadastros(evento("GET /cadastros/dispositivos/{id}/historico", { params: { id: cam.id } })));
    expect(hist).toHaveLength(2);
    expect(hist.filter((h: { fim: string | null }) => h.fim === null)).toHaveLength(1);
    const [d] = await sql`SELECT empresa_id, status::text AS status FROM silver.dispositivos WHERE id = ${cam.id}`;
    expect(d).toEqual({ empresa_id: EMPRESA_DEMO, status: "ativo" });

    // Outra empresa não mexe nesta câmera.
    const OUTRA = "00000000-0000-4000-8000-0000000000ee";
    await sql`INSERT INTO silver.empresas (id, cnpj_hash, razao_social) VALUES (${OUTRA}, 'outra-2', 'Outra 2') ON CONFLICT DO NOTHING`;
    const alheio = await cadastros(evento("POST /cadastros/dispositivos/{id}/desvincular", { params: { id: cam.id }, corpo: {}, empresaId: OUTRA }));
    expect(alheio.statusCode).toBe(403);
  });
});

describe("rotas e viagens", () => {
  it("rota guarda as BRs no formato da PRF e as UFs de origem e destino", async () => {
    const r = await cadastros(evento("POST /cadastros/rotas", { corpo: { origemCidade: "Santos", origemUf: "SP", destinoCidade: "Uberaba", destinoUf: "MG", brs: ["BR-050", "116", "050"] } }));
    expect(r.statusCode).toBe(201);
    const rotas = corpoJson(await cadastros(evento("GET /cadastros/rotas")));
    const nova = rotas.find((x: { id: string }) => x.id === corpoJson(r).id);
    expect(nova.brs).toEqual(["50", "116"]);
    expect(nova.ufsPercorridas).toEqual(["SP", "MG"]);
  });

  it("viagem só com rota e veículo da empresa, chegada depois da partida", async () => {
    const rotas = corpoJson(await cadastros(evento("GET /cadastros/rotas")));
    const veiculos = corpoJson(await cadastros(evento("GET /cadastros/veiculos")));
    const ok = await cadastros(evento("POST /cadastros/viagens", {
      corpo: { rotaId: rotas[0].id, veiculoId: veiculos[0].id, partidaPrevista: "2026-10-20T08:00:00-03:00", chegadaPrevista: "2026-10-20T18:00:00-03:00", valorViagem: 5200 },
    }));
    expect(ok.statusCode).toBe(201);
    const invertida = await cadastros(evento("POST /cadastros/viagens", {
      corpo: { rotaId: rotas[0].id, veiculoId: veiculos[0].id, partidaPrevista: "2026-10-20T18:00:00-03:00", chegadaPrevista: "2026-10-20T08:00:00-03:00" },
    }));
    expect(invertida.statusCode).toBe(400);
    const alheia = await cadastros(evento("POST /cadastros/viagens", {
      corpo: { rotaId: "00000000-0000-4000-8000-00000000abcd", veiculoId: veiculos[0].id, partidaPrevista: "2026-10-20T08:00:00-03:00" },
    }));
    expect(alheia.statusCode).toBe(400);
  });
});

describe("parâmetros do ROI", () => {
  it("valor da empresa sobrepõe o padrão e pode ser restaurado", async () => {
    const antes = await roi.calcular(EMPRESA_DEMO);
    const r = await cadastros(evento("PUT /cadastros/parametros-roi/{chave}", { params: { chave: "eficacia_alerta" }, corpo: { valor: 0.3, fonte: "piloto interno" } }));
    expect(corpoJson(r)).toMatchObject({ valor: 0.3, personalizado: true, fonte: "piloto interno" });
    const depois = await roi.calcular(EMPRESA_DEMO);
    expect(depois.cenarios.conservador.acidentesEvitados).toBeLessThan(antes.cenarios.conservador.acidentesEvitados);

    const volta = await cadastros(evento("DELETE /cadastros/parametros-roi/{chave}", { params: { chave: "eficacia_alerta" } }));
    expect(corpoJson(volta)).toMatchObject({ valor: 0.5, personalizado: false });
  });

  it("fração fora de 0..1 e parâmetro calculado são recusados", async () => {
    expect((await cadastros(evento("PUT /cadastros/parametros-roi/{chave}", { params: { chave: "eficacia_alerta" }, corpo: { valor: 3 } }))).statusCode).toBe(400);
    expect((await cadastros(evento("PUT /cadastros/parametros-roi/{chave}", { params: { chave: "fator_ipca" }, corpo: { valor: 2 } }))).statusCode).toBe(403);
  });
});
