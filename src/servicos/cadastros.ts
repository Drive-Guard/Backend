/**
 * Cadastros feitos pelo gestor: empresa, motoristas, veículos, câmeras (e em
 * qual veículo cada uma está), rotas, viagens e parâmetros do ROI.
 *
 * O dispositivo embarcado só conhece o próprio device_id e o ID do motorista
 * gravado nele (enviado como hash). Tudo o mais nasce aqui:
 *   - o código do motorista é o mesmo valor gravado no dispositivo: o hash
 *     do código casa com o motorista_hash da telemetria;
 *   - a câmera é associada a um veículo (o código da câmera é o código do
 *     veículo nos relatórios); trocar de veículo encerra o vínculo anterior.
 */

import { z } from "zod";
import { autor, sha256, type Usuario } from "../lib/auth";
import { db, type Sql } from "../lib/db";
import { conflito, invalido, naoEncontrado, proibido } from "../lib/http";
import { TIPOS_VEICULO } from "../lib/filtros";
import * as roi from "./roi";

const CNPJ_PROVISORIO = process.env.EMPRESA_PADRAO_CNPJ_HASH ?? "00000000000000000000000000000000";
const uuid = z.string().uuid("id inválido");
const uf = z.string().trim().length(2).transform((s) => s.toUpperCase());
const textoOpcional = (max: number) => z.string().trim().max(max).optional().nullable().transform((s) => (s ? s : null));

async function empresaProvisoria(sql: Sql): Promise<string | null> {
  const [e] = await sql`SELECT id FROM silver.empresas WHERE cnpj_hash = ${CNPJ_PROVISORIO}`;
  return (e?.id as string) ?? null;
}

// ---------------------------------------------------------------------------
// Empresa e UFs
// ---------------------------------------------------------------------------

export async function empresa(u: Usuario) {
  const sql = db();
  const [e] = await sql`
    SELECT id, razao_social AS "razaoSocial", nome_fantasia AS "nomeFantasia", frota_total AS "frotaTotal", uf, cidade,
           (SELECT COUNT(*)::int FROM silver.veiculos v WHERE v.empresa_id = e.id AND v.ativo) AS "veiculosCadastrados"
      FROM silver.empresas e WHERE id = ${u.empresaId}
  `;
  if (!e) throw naoEncontrado("Empresa");
  return e;
}

export const schemaEmpresa = z.object({
  nomeFantasia: textoOpcional(120),
  frotaTotal: z.number().int().min(1).max(100000).nullable().optional(),
  uf: uf.nullable().optional(),
  cidade: textoOpcional(120),
});

export async function atualizarEmpresa(u: Usuario, d: z.infer<typeof schemaEmpresa>) {
  const sql = db();
  await sql`
    UPDATE silver.empresas
       SET nome_fantasia = COALESCE(${d.nomeFantasia ?? null}, nome_fantasia),
           frota_total   = ${d.frotaTotal === undefined ? sql`frota_total` : d.frotaTotal},
           uf            = COALESCE(${d.uf ?? null}, uf),
           cidade        = COALESCE(${d.cidade ?? null}, cidade)
     WHERE id = ${u.empresaId}
  `;
  return empresa(u);
}

export async function ufs() {
  const sql = db();
  return sql`SELECT uf, nome, macro_regiao AS "macroRegiao" FROM silver.dim_uf ORDER BY uf`;
}

// ---------------------------------------------------------------------------
// Motoristas
// ---------------------------------------------------------------------------

export async function listarMotoristas(u: Usuario) {
  const sql = db();
  return sql`
    SELECT m.id, m.codigo, m.nome_exibicao AS nome, m.idade, m.anos_experiencia AS "anosExperiencia",
           m.categoria_cnh AS "categoriaCnh", m.cnh_valida_ate::text AS "cnhValidaAte", m.regiao_uf AS "regiaoUf",
           m.status::text AS status, m.codigo IS NOT NULL AS cadastrado, m.criado_em AS "criadoEm",
           (SELECT MAX(l.registrado_em) FROM silver.leituras_fadiga l WHERE l.motorista_id = m.id) AS "ultimaLeituraEm"
      FROM silver.motoristas m
     WHERE m.empresa_id = ${u.empresaId}
     ORDER BY (m.codigo IS NULL) DESC, m.codigo NULLS LAST, m.nome_exibicao
  `;
}

const camposMotorista = {
  nome: z.string().trim().min(2).max(120),
  idade: z.number().int().min(18).max(90).nullable().optional(),
  anosExperiencia: z.number().int().min(0).max(70).nullable().optional(),
  categoriaCnh: z.string().trim().toUpperCase().regex(/^[A-E]{1,2}$/, "categoria inválida").nullable().optional(),
  cnhValidaAte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  regiaoUf: uf.nullable().optional(),
  status: z.enum(["ativo", "inativo", "afastado", "ferias"]).default("ativo"),
};

export const schemaNovoMotorista = z.object({
  codigo: z.string().trim().min(2).max(40).regex(/^[\w.-]+$/, "use letras, números, ponto, hífen ou sublinhado"),
  ...camposMotorista,
});
export const schemaMotorista = z.object(camposMotorista);

/**
 * Cadastra pelo código. Se a telemetria desse código já chegou (motorista
 * "não cadastrado", nesta empresa ou na provisória), completa esse registro
 * em vez de criar outro: o histórico de turnos e alertas fica com ele.
 */
export async function criarMotorista(u: Usuario, d: z.infer<typeof schemaNovoMotorista>) {
  const sql = db();
  const hash = sha256(d.codigo);
  return sql.begin(async (tx) => {
    const provisoria = await empresaProvisoria(tx as unknown as Sql);
    const [existente] = await tx`SELECT id, empresa_id, codigo FROM silver.motoristas WHERE motorista_hash = ${hash} FOR UPDATE`;
    if (existente && existente.empresa_id !== u.empresaId && existente.empresa_id !== provisoria) {
      throw conflito("Este código já pertence a um motorista de outra empresa.");
    }
    if (existente?.codigo && existente.empresa_id === u.empresaId) throw conflito(`O código ${d.codigo} já está cadastrado.`);

    const valores = {
      empresa_id: u.empresaId,
      codigo: d.codigo,
      nome_exibicao: d.nome,
      idade: d.idade ?? null,
      anos_experiencia: d.anosExperiencia ?? null,
      categoria_cnh: d.categoriaCnh ?? null,
      cnh_valida_ate: d.cnhValidaAte ?? null,
      regiao_uf: d.regiaoUf ?? null,
    };
    if (existente) {
      const [m] = await tx`
        UPDATE silver.motoristas SET ${tx(valores)}, status = ${d.status}::silver.status_motorista
         WHERE id = ${existente.id} RETURNING id, codigo, nome_exibicao AS nome
      `;
      return { ...m, completouTelemetria: true };
    }
    const [m] = await tx`
      INSERT INTO silver.motoristas ${tx({ ...valores, motorista_hash: hash })}
      RETURNING id, codigo, nome_exibicao AS nome
    `;
    await tx`UPDATE silver.motoristas SET status = ${d.status}::silver.status_motorista WHERE id = ${m.id}`;
    return { ...m, completouTelemetria: false };
  });
}

export async function atualizarMotorista(u: Usuario, id: string, d: z.infer<typeof schemaMotorista>) {
  uuid.parse(id);
  const sql = db();
  const [m] = await sql`
    UPDATE silver.motoristas
       SET nome_exibicao = ${d.nome}, idade = ${d.idade ?? null}, anos_experiencia = ${d.anosExperiencia ?? null},
           categoria_cnh = ${d.categoriaCnh ?? null}, cnh_valida_ate = ${d.cnhValidaAte ?? null}::date,
           regiao_uf = ${d.regiaoUf ?? null}, status = ${d.status}::silver.status_motorista
     WHERE id = ${id} AND empresa_id = ${u.empresaId}
    RETURNING id, codigo, nome_exibicao AS nome, status::text AS status
  `;
  if (!m) throw naoEncontrado("Motorista");
  return m;
}

// ---------------------------------------------------------------------------
// Veículos
// ---------------------------------------------------------------------------

/** "abc-1d23" -> "ABC1D23": a mesma placa sempre vira o mesmo hash. */
export const normalizarPlaca = (placa: string) => placa.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function listarVeiculos(u: Usuario) {
  const sql = db();
  return sql`
    SELECT v.id, v.placa, v.tipo::text AS tipo, v.modelo, v.ano_fabricacao AS "anoFabricacao",
           v.capacidade_passageiros AS "capacidadePassageiros", v.ativo,
           d.id AS "dispositivoId", d.codigo AS "cameraCodigo", d.device_id AS "deviceId", d.status::text AS "cameraStatus",
           d.ultimo_contato_em AS "ultimoContatoEm", vd.inicio AS "cameraDesde"
      FROM silver.veiculos v
      LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.veiculo_id = v.id AND vd.fim IS NULL
      LEFT JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
     WHERE v.empresa_id = ${u.empresaId}
     ORDER BY v.ativo DESC, v.placa NULLS LAST
  `;
}

const camposVeiculo = {
  tipo: z.enum(TIPOS_VEICULO),
  modelo: textoOpcional(80),
  anoFabricacao: z.number().int().min(1980).max(2100).nullable().optional(),
  capacidadePassageiros: z.number().int().min(0).max(200).nullable().optional(),
  ativo: z.boolean().default(true),
};
export const schemaNovoVeiculo = z.object({
  placa: z.string().trim().min(7).max(10).transform(normalizarPlaca).refine((p) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p), "placa inválida (AAA1234 ou AAA1A23)"),
  ...camposVeiculo,
});
export const schemaVeiculo = z.object(camposVeiculo);

export async function criarVeiculo(u: Usuario, d: z.infer<typeof schemaNovoVeiculo>) {
  const sql = db();
  const hash = sha256(d.placa);
  const [existe] = await sql`SELECT empresa_id FROM silver.veiculos WHERE placa_hash = ${hash}`;
  if (existe && existe.empresa_id !== u.empresaId) throw conflito("Esta placa já está cadastrada em outra empresa.");
  if (existe) throw conflito(`A placa ${d.placa} já está cadastrada.`);
  const [v] = await sql`
    INSERT INTO silver.veiculos (empresa_id, placa_hash, placa, tipo, modelo, ano_fabricacao, capacidade_passageiros, ativo)
    VALUES (${u.empresaId}, ${hash}, ${d.placa}, ${d.tipo}::silver.tipo_veiculo, ${d.modelo ?? null}, ${d.anoFabricacao ?? null},
            ${d.capacidadePassageiros ?? null}, ${d.ativo})
    RETURNING id, placa, tipo::text AS tipo
  `;
  return v;
}

export async function atualizarVeiculo(u: Usuario, id: string, d: z.infer<typeof schemaVeiculo>) {
  uuid.parse(id);
  const sql = db();
  return sql.begin(async (tx) => {
    const [v] = await tx`
      UPDATE silver.veiculos
         SET tipo = ${d.tipo}::silver.tipo_veiculo, modelo = ${d.modelo ?? null}, ano_fabricacao = ${d.anoFabricacao ?? null},
             capacidade_passageiros = ${d.capacidadePassageiros ?? null}, ativo = ${d.ativo}
       WHERE id = ${id} AND empresa_id = ${u.empresaId}
      RETURNING id, placa, tipo::text AS tipo, ativo
    `;
    if (!v) throw naoEncontrado("Veículo");
    // Veículo desativado não fica com câmera.
    if (!d.ativo) {
      await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = GREATEST(now(), inicio + interval '1 second'), motivo = COALESCE(motivo, 'veículo desativado')
                WHERE veiculo_id = ${id} AND fim IS NULL`;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Câmeras
// ---------------------------------------------------------------------------

export async function listarDispositivos(u: Usuario) {
  const sql = db();
  return sql`
    SELECT d.id, d.device_id AS "deviceId", d.codigo, d.descricao, d.status::text AS status, d.ultimo_contato_em AS "ultimoContatoEm",
           d.empresa_id IS NULL AS pendente, d.criado_em AS "criadoEm",
           v.id AS "veiculoId", v.placa, v.tipo::text AS "veiculoTipo", vd.inicio AS "vinculadoDesde",
           (SELECT m.codigo FROM silver.turnos t JOIN silver.motoristas m ON m.id = t.motorista_id
             WHERE t.dispositivo_id = d.id ORDER BY t.iniciado_em DESC LIMIT 1) AS "ultimoMotoristaCodigo",
           (SELECT m.nome_exibicao FROM silver.turnos t JOIN silver.motoristas m ON m.id = t.motorista_id
             WHERE t.dispositivo_id = d.id ORDER BY t.iniciado_em DESC LIMIT 1) AS "ultimoMotoristaNome"
      FROM silver.dispositivos d
      LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.dispositivo_id = d.id AND vd.fim IS NULL
      LEFT JOIN silver.veiculos v ON v.id = vd.veiculo_id
     WHERE d.empresa_id = ${u.empresaId} OR d.empresa_id IS NULL
     ORDER BY (d.empresa_id IS NULL) DESC, d.status, d.codigo NULLS LAST
  `;
}

export const schemaNovoDispositivo = z.object({
  deviceId: z.string().trim().min(3).max(64).regex(/^[\w.-]+$/, "use letras, números, ponto, hífen ou sublinhado"),
  codigo: z.string().trim().min(2).max(40),
  descricao: textoOpcional(200),
});
export const schemaDispositivo = z.object({
  codigo: z.string().trim().min(2).max(40),
  descricao: textoOpcional(200),
  status: z.enum(["ativo", "pendente", "inativo"]),
});

export async function criarDispositivo(u: Usuario, d: z.infer<typeof schemaNovoDispositivo>) {
  const sql = db();
  const [existe] = await sql`SELECT id, empresa_id FROM silver.dispositivos WHERE device_id = ${d.deviceId}`;
  if (existe && existe.empresa_id && existe.empresa_id !== u.empresaId) throw conflito("Esta câmera pertence a outra empresa.");
  // Câmera que já mandou dado (pendente) é assumida pela empresa.
  const [r] = await sql`
    INSERT INTO silver.dispositivos (empresa_id, device_id, codigo, descricao, status)
    VALUES (${u.empresaId}, ${d.deviceId}, ${d.codigo}, ${d.descricao ?? null}, 'ativo')
    ON CONFLICT (device_id) DO UPDATE SET empresa_id = EXCLUDED.empresa_id, codigo = EXCLUDED.codigo,
                                          descricao = COALESCE(EXCLUDED.descricao, silver.dispositivos.descricao)
    RETURNING id, device_id AS "deviceId", codigo, status::text AS status
  `;
  return r;
}

async function dispositivoDaEmpresa(tx: Sql, u: Usuario, id: string, bloquear = false) {
  uuid.parse(id);
  const [d] = bloquear
    ? await tx`SELECT id, empresa_id FROM silver.dispositivos WHERE id = ${id} FOR UPDATE`
    : await tx`SELECT id, empresa_id FROM silver.dispositivos WHERE id = ${id}`;
  if (!d) throw naoEncontrado("Câmera");
  if (d.empresa_id && d.empresa_id !== u.empresaId) throw proibido("Esta câmera pertence a outra empresa.");
  return d;
}

export async function atualizarDispositivo(u: Usuario, id: string, d: z.infer<typeof schemaDispositivo>) {
  const sql = db();
  return sql.begin(async (tx) => {
    await dispositivoDaEmpresa(tx as unknown as Sql, u, id, true);
    const [r] = await tx`
      UPDATE silver.dispositivos SET codigo = ${d.codigo}, descricao = ${d.descricao ?? null},
             status = ${d.status}::silver.status_dispositivo, empresa_id = ${u.empresaId}
       WHERE id = ${id} RETURNING id, codigo, status::text AS status
    `;
    if (d.status === "inativo") {
      await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = GREATEST(now(), inicio + interval '1 second'), motivo = COALESCE(motivo, 'câmera desativada')
                WHERE dispositivo_id = ${id} AND fim IS NULL`;
    }
    return r;
  });
}

export const schemaVinculo = z.object({
  veiculoId: z.string().uuid(),
  motivo: textoOpcional(200),
});

/**
 * Instala a câmera num veículo. Se ela estava em outro, ou se o veículo tinha
 * outra câmera, os vínculos antigos são encerrados agora: o ETL usa o vínculo
 * vigente na hora de cada leitura, então o histórico continua certo.
 */
export async function vincularDispositivo(u: Usuario, id: string, d: z.infer<typeof schemaVinculo>) {
  const sql = db();
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await dispositivoDaEmpresa(t, u, id, true);
    const [v] = await tx`SELECT id FROM silver.veiculos WHERE id = ${d.veiculoId} AND empresa_id = ${u.empresaId} AND ativo FOR UPDATE`;
    if (!v) throw naoEncontrado("Veículo ativo");

    const [atual] = await tx`SELECT veiculo_id FROM silver.vinculos_dispositivo_veiculo WHERE dispositivo_id = ${id} AND fim IS NULL`;
    if (atual?.veiculo_id === d.veiculoId) return { dispositivoId: id, veiculoId: d.veiculoId, alterado: false };

    const fim = tx`GREATEST(now(), inicio + interval '1 second')`;
    await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fim}, motivo = COALESCE(motivo, ${d.motivo ?? "troca de veículo"})
              WHERE fim IS NULL AND (dispositivo_id = ${id} OR veiculo_id = ${d.veiculoId})`;
    const [novo] = await tx`
      INSERT INTO silver.vinculos_dispositivo_veiculo (dispositivo_id, veiculo_id, inicio, motivo, criado_por)
      VALUES (${id}, ${d.veiculoId}, now(), ${d.motivo ?? null}, ${autor(u)})
      RETURNING id, inicio
    `;
    await tx`UPDATE silver.dispositivos SET empresa_id = ${u.empresaId}, status = 'ativo' WHERE id = ${id}`;

    // Motoristas que só apareceram por esta câmera (empresa provisória) passam para a empresa.
    const provisoria = await empresaProvisoria(t);
    if (provisoria) {
      await tx`
        UPDATE silver.motoristas SET empresa_id = ${u.empresaId}
         WHERE empresa_id = ${provisoria}
           AND id IN (SELECT motorista_id FROM silver.turnos WHERE dispositivo_id = ${id})
      `;
    }
    return { dispositivoId: id, veiculoId: d.veiculoId, vinculoId: novo.id, inicio: novo.inicio, alterado: true };
  });
}

export async function desvincularDispositivo(u: Usuario, id: string, motivo?: string | null) {
  const sql = db();
  await dispositivoDaEmpresa(sql, u, id);
  const r = await sql`
    UPDATE silver.vinculos_dispositivo_veiculo SET fim = GREATEST(now(), inicio + interval '1 second'), motivo = COALESCE(motivo, ${motivo ?? "câmera retirada"})
     WHERE dispositivo_id = ${id} AND fim IS NULL RETURNING id
  `;
  return { encerrados: r.length };
}

export async function historicoDispositivo(u: Usuario, id: string) {
  const sql = db();
  await dispositivoDaEmpresa(sql, u, id);
  return sql`
    SELECT vd.id, vd.inicio, vd.fim, vd.motivo, v.id AS "veiculoId", v.placa, v.tipo::text AS tipo
      FROM silver.vinculos_dispositivo_veiculo vd JOIN silver.veiculos v ON v.id = vd.veiculo_id
     WHERE vd.dispositivo_id = ${id}
     ORDER BY vd.inicio DESC
  `;
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

/** "BR-040", "40", "br 116" -> "40", "116" (formato da PRF). */
export const normalizarBr = (br: string) => br.replace(/\D/g, "").replace(/^0+/, "");

export const schemaRota = z.object({
  nome: textoOpcional(120),
  origemCidade: z.string().trim().min(2).max(120),
  origemUf: uf,
  destinoCidade: z.string().trim().min(2).max(120),
  destinoUf: uf,
  brs: z.array(z.string()).max(20).default([]).transform((l) => [...new Set(l.map(normalizarBr).filter(Boolean))]),
  ufsPercorridas: z.array(uf).max(27).default([]),
  distanciaKm: z.number().min(1).max(10000).nullable().optional(),
  ativo: z.boolean().default(true),
});

export async function listarRotas(u: Usuario) {
  const sql = db();
  return sql`
    SELECT id, nome, origem_cidade AS "origemCidade", origem_uf AS "origemUf", destino_cidade AS "destinoCidade",
           destino_uf AS "destinoUf", brs, ufs_percorridas::text[] AS "ufsPercorridas", distancia_km AS "distanciaKm", ativo,
           (SELECT COUNT(*)::int FROM silver.viagens vg WHERE vg.rota_id = r.id) AS viagens
      FROM silver.rotas r WHERE empresa_id = ${u.empresaId}
     ORDER BY ativo DESC, origem_cidade, destino_cidade
  `;
}

function ufsDaRota(d: z.infer<typeof schemaRota>) {
  return [...new Set([d.origemUf, ...d.ufsPercorridas, d.destinoUf])];
}

export async function criarRota(u: Usuario, d: z.infer<typeof schemaRota>) {
  const sql = db();
  const [r] = await sql`
    INSERT INTO silver.rotas (empresa_id, nome, origem_cidade, origem_uf, destino_cidade, destino_uf, brs, ufs_percorridas, distancia_km, ativo)
    VALUES (${u.empresaId}, ${d.nome ?? null}, ${d.origemCidade}, ${d.origemUf}, ${d.destinoCidade}, ${d.destinoUf},
            ${sql.array(d.brs)}, ${sql.array(ufsDaRota(d))}::char(2)[], ${d.distanciaKm ?? null}, ${d.ativo})
    RETURNING id
  `;
  return r;
}

export async function atualizarRota(u: Usuario, id: string, d: z.infer<typeof schemaRota>) {
  uuid.parse(id);
  const sql = db();
  const [r] = await sql`
    UPDATE silver.rotas
       SET nome = ${d.nome ?? null}, origem_cidade = ${d.origemCidade}, origem_uf = ${d.origemUf}, destino_cidade = ${d.destinoCidade},
           destino_uf = ${d.destinoUf}, brs = ${sql.array(d.brs)}, ufs_percorridas = ${sql.array(ufsDaRota(d))}::char(2)[],
           distancia_km = ${d.distanciaKm ?? null}, ativo = ${d.ativo}
     WHERE id = ${id} AND empresa_id = ${u.empresaId}
    RETURNING id
  `;
  if (!r) throw naoEncontrado("Rota");
  return r;
}

// ---------------------------------------------------------------------------
// Viagens
// ---------------------------------------------------------------------------

const instante = z.string().datetime({ offset: true, message: "use data e hora ISO-8601 com fuso" });

export const schemaViagem = z
  .object({
    rotaId: z.string().uuid(),
    veiculoId: z.string().uuid(),
    motoristaId: z.string().uuid().nullable().optional(),
    partidaPrevista: instante,
    chegadaPrevista: instante.nullable().optional(),
    valorViagem: z.number().min(0).max(10_000_000).nullable().optional(),
    status: z.enum(["planejada", "em_andamento", "concluida", "cancelada"]).default("planejada"),
  })
  .refine((v) => !v.chegadaPrevista || v.chegadaPrevista > v.partidaPrevista, { message: "a chegada deve ser depois da partida", path: ["chegadaPrevista"] });

export const schemaFiltroViagens = z.object({
  status: z.enum(["planejada", "em_andamento", "concluida", "cancelada"]).optional(),
  veiculo_id: z.string().uuid().optional(),
  dias: z.coerce.number().int().min(1).max(365).default(30),
});

export async function listarViagens(u: Usuario, f: z.infer<typeof schemaFiltroViagens>) {
  const sql = db();
  return sql`
    SELECT vg.id, vg.status::text AS status, vg.partida_prevista AS "partidaPrevista", vg.chegada_prevista AS "chegadaPrevista",
           vg.partida_real AS "partidaReal", vg.chegada_real AS "chegadaReal", vg.valor_viagem AS "valorViagem",
           r.id AS "rotaId", r.origem_cidade || '/' || r.origem_uf || ' → ' || r.destino_cidade || '/' || r.destino_uf AS rota,
           v.id AS "veiculoId", v.placa, m.id AS "motoristaId", m.codigo AS "motoristaCodigo", m.nome_exibicao AS "motoristaNome",
           (SELECT COUNT(*)::int FROM silver.turnos t WHERE t.viagem_id = vg.id) AS turnos
      FROM silver.viagens vg
      JOIN silver.rotas r ON r.id = vg.rota_id
      JOIN silver.veiculos v ON v.id = vg.veiculo_id
      LEFT JOIN silver.motoristas m ON m.id = vg.motorista_id
     WHERE vg.empresa_id = ${u.empresaId}
       AND vg.partida_prevista >= now() - make_interval(days => ${f.dias})
       ${f.status ? sql`AND vg.status = ${f.status}::silver.status_viagem` : sql``}
       ${f.veiculo_id ? sql`AND vg.veiculo_id = ${f.veiculo_id}` : sql``}
     ORDER BY vg.partida_prevista DESC
     LIMIT 500
  `;
}

async function validarReferencias(sql: Sql, u: Usuario, d: z.infer<typeof schemaViagem>) {
  const [ok] = await sql`
    SELECT (SELECT COUNT(*) FROM silver.rotas WHERE id = ${d.rotaId} AND empresa_id = ${u.empresaId})::int AS rota,
           (SELECT COUNT(*) FROM silver.veiculos WHERE id = ${d.veiculoId} AND empresa_id = ${u.empresaId})::int AS veiculo,
           (SELECT COUNT(*) FROM silver.motoristas WHERE id = ${d.motoristaId ?? null} AND empresa_id = ${u.empresaId})::int AS motorista
  `;
  if (!ok.rota) throw invalido("Rota não encontrada");
  if (!ok.veiculo) throw invalido("Veículo não encontrado");
  if (d.motoristaId && !ok.motorista) throw invalido("Motorista não encontrado");
}

export async function criarViagem(u: Usuario, d: z.infer<typeof schemaViagem>) {
  const sql = db();
  await validarReferencias(sql, u, d);
  const [r] = await sql`
    INSERT INTO silver.viagens (empresa_id, rota_id, veiculo_id, motorista_id, partida_prevista, chegada_prevista, valor_viagem, status)
    VALUES (${u.empresaId}, ${d.rotaId}, ${d.veiculoId}, ${d.motoristaId ?? null}, ${d.partidaPrevista}, ${d.chegadaPrevista ?? null},
            ${d.valorViagem ?? null}, ${d.status}::silver.status_viagem)
    RETURNING id
  `;
  return r;
}

export async function atualizarViagem(u: Usuario, id: string, d: z.infer<typeof schemaViagem>) {
  uuid.parse(id);
  const sql = db();
  await validarReferencias(sql, u, d);
  const [r] = await sql`
    UPDATE silver.viagens
       SET rota_id = ${d.rotaId}, veiculo_id = ${d.veiculoId}, motorista_id = ${d.motoristaId ?? null},
           partida_prevista = ${d.partidaPrevista}, chegada_prevista = ${d.chegadaPrevista ?? null},
           valor_viagem = ${d.valorViagem ?? null}, status = ${d.status}::silver.status_viagem
     WHERE id = ${id} AND empresa_id = ${u.empresaId}
    RETURNING id
  `;
  if (!r) throw naoEncontrado("Viagem");
  return r;
}

// ---------------------------------------------------------------------------
// Parâmetros do ROI
// ---------------------------------------------------------------------------

export const listarParametrosRoi = (u: Usuario) => roi.parametros(u.empresaId).then((p) => Object.values(p));

export const schemaParametro = z.object({
  valor: z.number().min(0).max(1e9),
  fonte: textoOpcional(200),
});

const LIMITES_FRACAO = new Set(["eficacia_alerta", "fracao_sono_conservador", "fracao_sono_realista", "proporcao_fatal_padrao", "proporcao_feridos_padrao"]);

export async function definirParametroRoi(u: Usuario, chave: string, d: z.infer<typeof schemaParametro>) {
  const sql = db();
  const [p] = await sql`SELECT editavel FROM silver.parametros_roi_padrao WHERE chave = ${chave}`;
  if (!p) throw naoEncontrado("Parâmetro");
  if (!p.editavel) throw proibido("Este parâmetro é calculado pelo sistema e não pode ser alterado.");
  if (LIMITES_FRACAO.has(chave) && d.valor > 1) throw invalido("Este parâmetro é uma fração entre 0 e 1.");
  await sql`
    INSERT INTO silver.parametros_roi (empresa_id, chave, valor, fonte, atualizado_por)
    VALUES (${u.empresaId}, ${chave}, ${d.valor}, ${d.fonte ?? "Informado pelo gestor"}, ${autor(u)})
    ON CONFLICT (empresa_id, chave) DO UPDATE SET valor = EXCLUDED.valor, fonte = EXCLUDED.fonte,
           atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()
  `;
  return (await roi.parametros(u.empresaId))[chave];
}

export async function restaurarParametroRoi(u: Usuario, chave: string) {
  const sql = db();
  await sql`DELETE FROM silver.parametros_roi WHERE empresa_id = ${u.empresaId} AND chave = ${chave}`;
  const p = (await roi.parametros(u.empresaId))[chave];
  if (!p) throw naoEncontrado("Parâmetro");
  return p;
}
