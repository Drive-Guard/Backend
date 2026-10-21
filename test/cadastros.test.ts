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
      VALUES (${prov.id}, ${sha("drv-7777")}, 'Motorista não cadastrado (abc123)') RETURNING id`;

    const r = await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "DRV-7777", nome: "Marta Teixeira", idade: 41, regiaoUf: "sp" } }));
    expect(r.statusCode).toBe(201);
    expect(corpoJson(r)).toMatchObject({ id: orfao.id, completouTelemetria: true });
    const [m] = await sql`SELECT empresa_id, codigo, nome_exibicao, regiao_uf FROM silver.motoristas WHERE id = ${orfao.id}`;
    expect(m).toMatchObject({ empresa_id: EMPRESA_DEMO, codigo: "DRV-7777", nome_exibicao: "Marta Teixeira", regiao_uf: "SP" });

    const repetido = await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "DRV-7777", nome: "Outra" } }));
    expect(repetido.statusCode).toBe(409);
  });

  it("o código é normalizado e o hash ignora maiúsculas, acento e separador", async () => {
    const sql = db();
    const r = corpoJson(await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "Caetano.Resende Domingues", nome: "Caetano Resende" } })));
    expect(r.codigo).toBe("Caetano-Resende-Domingues");
    const [m] = await sql`SELECT motorista_hash FROM silver.motoristas WHERE id = ${r.id}`;
    // O dispositivo com DRIVEGUARD_MOTORISTA_ID="caetano_resende.domingues" manda este mesmo hash.
    expect(m.motorista_hash).toBe(sha("caetano-resende-domingues"));

    // Sem código, ele sai do nome.
    const semCodigo = corpoJson(await cadastros(evento("POST /cadastros/motoristas", { corpo: { nome: "João Sebastião da Silva" } })));
    expect(semCodigo.codigo).toBe("joao-sebastiao-da-silva");
  });

  it("completa o motorista que chegou pela telemetria sem mexer no hash", async () => {
    const sql = db();
    const [orfao] = await sql`
      INSERT INTO silver.motoristas (empresa_id, motorista_hash, nome_exibicao)
      VALUES (${EMPRESA_DEMO}, ${sha("Caetano.Resende.Domingues")}, 'Motorista não cadastrado (9f1c2a)') RETURNING id`;
    const r = await cadastros(evento("POST /cadastros/motoristas/{id}/completar", { params: { id: orfao.id }, corpo: { nome: "Caetano Domingues" } }));
    expect(r.statusCode).toBe(200);
    expect(corpoJson(r)).toMatchObject({ codigo: "caetano-domingues", nome: "Caetano Domingues" });
    const [m] = await sql`SELECT motorista_hash FROM silver.motoristas WHERE id = ${orfao.id}`;
    expect(m.motorista_hash).toBe(sha("Caetano.Resende.Domingues"));
    const deNovo = await cadastros(evento("POST /cadastros/motoristas/{id}/completar", { params: { id: orfao.id }, corpo: { nome: "Outro" } }));
    expect(deNovo.statusCode).toBe(409);
  });

  it("excluir apaga quem nunca dirigiu e arquiva quem tem histórico", async () => {
    const sql = db();
    const novo = corpoJson(await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "TMP-1", nome: "Sem Histórico" } })));
    expect(corpoJson(await cadastros(evento("DELETE /cadastros/motoristas/{id}", { params: { id: novo.id } })))).toEqual({ resultado: "excluido" });
    expect(await sql`SELECT 1 FROM silver.motoristas WHERE id = ${novo.id}`).toHaveLength(0);

    const veterano = corpoJson(await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "VET-42", nome: "Com Histórico" } })));
    await sql`INSERT INTO silver.turnos (motorista_id, device_id, iniciado_em, finalizado_em, status)
              VALUES (${veterano.id}, 'dg-teste-vet', now() - interval '3 days', now() - interval '3 days' + interval '6 hours', 'concluido')`;
    expect(corpoJson(await cadastros(evento("DELETE /cadastros/motoristas/{id}", { params: { id: veterano.id } })))).toEqual({ resultado: "arquivado" });
    const lista = corpoJson(await cadastros(evento("GET /cadastros/motoristas")));
    expect(lista.some((m: { id: string }) => m.id === veterano.id)).toBe(false);
    expect(await sql`SELECT 1 FROM silver.turnos WHERE motorista_id = ${veterano.id} LIMIT 1`).toHaveLength(1);

    // Cadastrar de novo o mesmo código traz o motorista (e o histórico) de volta.
    const volta = corpoJson(await cadastros(evento("POST /cadastros/motoristas", { corpo: { codigo: "vet 42", nome: "Com Histórico" } })));
    expect(volta).toMatchObject({ id: veterano.id, reativado: true });
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

describe("assistente", () => {
  it("coloca a câmera pendente em operação num veículo novo e completa o motorista dela", async () => {
    const sql = db();
    const [cam] = await sql`INSERT INTO silver.dispositivos (device_id, status, ultimo_contato_em) VALUES ('device-777', 'pendente', now()) RETURNING id`;
    const [orfao] = await sql`
      INSERT INTO silver.motoristas (empresa_id, motorista_hash, nome_exibicao)
      VALUES (${EMPRESA_DEMO}, ${sha("algum-id-do-edge")}, 'Motorista não cadastrado (77aa11)') RETURNING id`;

    const r = await cadastros(evento("POST /cadastros/operacao", {
      corpo: {
        camera: { dispositivoId: cam.id },
        veiculo: { placa: "OPR1C23", tipo: "caminhao", modelo: "Volvo FH" },
        motorista: { motoristaId: orfao.id, nome: "Rita Operação" },
      },
    }));
    expect(r.statusCode).toBe(201);
    const op = corpoJson(r);
    expect(op.camera).toMatchObject({ deviceId: "device-777", codigo: "OPR1C23" });
    // Motorista completado: o dispositivo já manda o ID dele, nada a mudar lá.
    expect(op.configuracao).toEqual({ DRIVEGUARD_DEVICE_ID: "device-777", DRIVEGUARD_MOTORISTA_ID: null });
    const [vinc] = await sql`SELECT veiculo_id FROM silver.vinculos_dispositivo_veiculo WHERE dispositivo_id = ${cam.id} AND fim IS NULL`;
    expect(vinc.veiculo_id).toBe(op.veiculo.id);

    // Motorista novo: o assistente devolve o ID a gravar no dispositivo.
    const nova = corpoJson(await cadastros(evento("POST /cadastros/operacao", {
      corpo: { camera: { deviceId: "Câmera Nova_01" }, veiculo: { placa: "OPR2D34", tipo: "onibus" }, motorista: { nome: "Lúcia Nova" } },
    })));
    expect(nova.configuracao).toEqual({ DRIVEGUARD_DEVICE_ID: "camera-nova-01", DRIVEGUARD_MOTORISTA_ID: "lucia-nova" });
  });

  it("câmera e veículo sem dados são apagados; com histórico, arquivados", async () => {
    const sql = db();
    const v = corpoJson(await cadastros(evento("POST /cadastros/veiculos", { corpo: { placa: "DEL1E45", tipo: "van" } })));
    expect(corpoJson(await cadastros(evento("DELETE /cadastros/veiculos/{id}", { params: { id: v.id } })))).toEqual({ resultado: "excluido" });
    const cam = corpoJson(await cadastros(evento("POST /cadastros/dispositivos", { corpo: { deviceId: "dg-teste-arquivo" } })));
    const v2 = corpoJson(await cadastros(evento("POST /cadastros/veiculos", { corpo: { placa: "DEL2F56", tipo: "caminhao" } })));
    await cadastros(evento("POST /cadastros/dispositivos/{id}/vincular", { params: { id: cam.id }, corpo: { veiculoId: v2.id } }));
    const [m] = await sql`SELECT id FROM silver.motoristas WHERE empresa_id = ${EMPRESA_DEMO} LIMIT 1`;
    await sql`INSERT INTO silver.turnos (motorista_id, device_id, dispositivo_id, iniciado_em, finalizado_em, status)
              VALUES (${m.id}, 'dg-teste-arquivo', ${cam.id}, now() - interval '400 days', now() - interval '400 days' + interval '1 hour', 'concluido')`;
    const comTurno = { id: cam.id as string };
    expect(corpoJson(await cadastros(evento("DELETE /cadastros/dispositivos/{id}", { params: { id: comTurno.id } })))).toEqual({ resultado: "arquivado" });
    const [d] = await sql`SELECT status::text AS status, arquivado_em IS NOT NULL AS arquivada,
                            (SELECT COUNT(*)::int FROM silver.vinculos_dispositivo_veiculo WHERE dispositivo_id = ${comTurno.id} AND fim IS NULL) AS abertos
                            FROM silver.dispositivos WHERE id = ${comTurno.id}`;
    expect(d).toEqual({ status: "inativo", arquivada: true, abertos: 0 });
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
