/**
 * Cadastros feitos pelo gestor: empresa, motoristas, veículos, câmeras (e em
 * qual veículo cada uma está), rotas, viagens e parâmetros do ROI.
 *
 * O dispositivo embarcado só conhece o próprio device_id e o ID do motorista
 * gravado nele (enviado como hash). Tudo o mais nasce aqui:
 *   - o código do motorista é o mesmo valor gravado no dispositivo: o hash do
 *     código normalizado casa com o motorista_hash da telemetria
 *     (lib/identificadores.ts: "Caetano Resende" = "caetano.resende");
 *   - a câmera é associada a um veículo (o código da câmera é o código do
 *     veículo nos relatórios); trocar de veículo encerra o vínculo anterior;
 *   - o assistente (`operacao`) faz os três de uma vez e devolve o que gravar
 *     no dispositivo.
 *
 * Excluir apaga o que nunca teve dado e arquiva o que tem histórico (some das
 * listas; relatórios e gráficos continuam com os dados antigos).
 */

import { z } from "zod";
import { autor, sha256, type Usuario } from "../lib/auth";
import { db, type Sql } from "../lib/db";
import { conflito, invalido, naoEncontrado, proibido } from "../lib/http";
import { TIPOS_VEICULO } from "../lib/filtros";
import { codigoDoNome, hashMotorista, normalizarDispositivo, normalizarId } from "../lib/identificadores";
import * as roi from "./roi";

const CNPJ_PROVISORIO = process.env.EMPRESA_PADRAO_CNPJ_HASH ?? "00000000000000000000000000000000";
const uuid = z.string().uuid("id inválido");
const uf = z.string().trim().length(2).transform((s) => s.toUpperCase());
const textoOpcional = (max: number) => z.string().trim().max(max).optional().nullable().transform((s) => (s ? s : null));

/** Código digitado pelo gestor: normalizado (sem acento, espaço vira hífen). */
const codigo = (max = 40) =>
  z
    .string()
    .transform(normalizarId)
    .pipe(z.string().min(2, "use ao menos 2 letras ou números").max(max, `no máximo ${max} caracteres`));

/** Resultado de uma exclusão: o que aconteceu de fato. */
export type ResultadoExclusao = { resultado: "excluido" | "arquivado" };

async function empresaProvisoria(sql: Sql): Promise<string | null> {
  const [e] = await sql`SELECT id FROM silver.empresas WHERE cnpj_hash = ${CNPJ_PROVISORIO}`;
  return (e?.id as string) ?? null;
}

const fimAgora = (tx: Sql) => tx`GREATEST(now(), inicio + interval '1 second')`;

// ---------------------------------------------------------------------------
// Empresa e UFs
// ---------------------------------------------------------------------------

export async function empresa(u: Usuario) {
  const sql = db();
  const [e] = await sql`
    SELECT id, razao_social AS "razaoSocial", nome_fantasia AS "nomeFantasia", frota_total AS "frotaTotal", uf, cidade,
           (SELECT COUNT(*)::int FROM silver.veiculos v WHERE v.empresa_id = e.id AND v.ativo AND v.arquivado_em IS NULL) AS "veiculosCadastrados"
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
           (SELECT MAX(l.registrado_em) FROM silver.leituras_fadiga l WHERE l.motorista_id = m.id) AS "ultimaLeituraEm",
           (SELECT d.device_id FROM silver.turnos t JOIN silver.dispositivos d ON d.id = t.dispositivo_id
             WHERE t.motorista_id = m.id ORDER BY t.iniciado_em DESC LIMIT 1) AS "ultimoDispositivo",
           (EXISTS (SELECT 1 FROM silver.turnos t WHERE t.motorista_id = m.id)
            OR EXISTS (SELECT 1 FROM silver.incidentes i WHERE i.motorista_id = m.id)) AS "temHistorico"
      FROM silver.motoristas m
     WHERE m.empresa_id = ${u.empresaId} AND m.arquivado_em IS NULL
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

/** Sem código, ele sai do nome ("João da Silva" -> "joao-da-silva"). */
export const schemaNovoMotorista = z.object({ codigo: codigo().optional().nullable(), ...camposMotorista });
export const schemaMotorista = z.object({ codigo: codigo().optional(), ...camposMotorista });
/** Motorista que chegou pela telemetria: só falta nome (o código vem do nome). */
export const schemaCompletarMotorista = z.object({ ...camposMotorista, codigo: codigo().optional().nullable() });

type DadosMotorista = z.infer<typeof schemaNovoMotorista>;

function valoresMotorista(u: Usuario, d: DadosMotorista, cod: string) {
  return {
    empresa_id: u.empresaId,
    codigo: cod,
    nome_exibicao: d.nome,
    idade: d.idade ?? null,
    anos_experiencia: d.anosExperiencia ?? null,
    categoria_cnh: d.categoriaCnh ?? null,
    cnh_valida_ate: d.cnhValidaAte ?? null,
    regiao_uf: d.regiaoUf ?? null,
  };
}

/** Código livre na empresa: "joao-silva", "joao-silva-2"... (só para os gerados do nome). */
async function codigoLivre(tx: Sql, u: Usuario, base: string, ignorar?: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const cand = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
    const [ocupado] = await tx`
      SELECT 1 FROM silver.motoristas
       WHERE empresa_id = ${u.empresaId} AND codigo = ${cand} AND arquivado_em IS NULL
         ${ignorar ? tx`AND id <> ${ignorar}` : tx``}`;
    if (!ocupado) return cand;
  }
  throw conflito("Não encontrei um código livre; informe um código.");
}

/**
 * Cadastra pelo código. Se a telemetria desse código já chegou (motorista
 * "não cadastrado", nesta empresa ou na provisória), completa esse registro
 * em vez de criar outro: o histórico de turnos e alertas fica com ele. Se o
 * mesmo código tinha sido excluído (arquivado), ele volta.
 */
type MotoristaCriado = { id: string; codigo: string; nome: string; completouTelemetria: boolean; reativado: boolean };

async function criarMotoristaTx(tx: Sql, u: Usuario, d: DadosMotorista): Promise<MotoristaCriado> {
  const cod = d.codigo ?? (await codigoLivre(tx, u, codigoDoNome(d.nome)));
  if (cod.length < 2) throw invalido("Informe um código com ao menos 2 letras ou números.");
  const hash = hashMotorista(cod);
  const provisoria = await empresaProvisoria(tx);
  const [existente] = await tx`
    SELECT id, empresa_id, codigo, arquivado_em FROM silver.motoristas WHERE motorista_hash = ${hash} FOR UPDATE`;
  if (existente && existente.empresa_id !== u.empresaId && existente.empresa_id !== provisoria) {
    throw conflito("Este código já pertence a um motorista de outra empresa.");
  }
  if (existente?.codigo && existente.empresa_id === u.empresaId && !existente.arquivado_em) {
    throw conflito(`O código ${cod} já está cadastrado.`);
  }
  const [mesmoCodigo] = await tx`
    SELECT 1 FROM silver.motoristas WHERE empresa_id = ${u.empresaId} AND codigo = ${cod} AND arquivado_em IS NULL
       ${existente ? tx`AND id <> ${existente.id}` : tx``}`;
  if (mesmoCodigo) throw conflito(`O código ${cod} já está em uso.`);

  const valores = valoresMotorista(u, d, cod);
  if (existente) {
    const [m] = await tx`
      UPDATE silver.motoristas SET ${tx(valores)}, status = ${d.status}::silver.status_motorista, arquivado_em = NULL
       WHERE id = ${existente.id} RETURNING id, codigo, nome_exibicao AS nome
    `;
    return { ...(m as { id: string; codigo: string; nome: string }), completouTelemetria: !existente.codigo, reativado: !!existente.arquivado_em };
  }
  const [m] = await tx`
    INSERT INTO silver.motoristas ${tx({ ...valores, motorista_hash: hash })}
    RETURNING id, codigo, nome_exibicao AS nome
  `;
  await tx`UPDATE silver.motoristas SET status = ${d.status}::silver.status_motorista WHERE id = ${m.id}`;
  return { ...(m as { id: string; codigo: string; nome: string }), completouTelemetria: false, reativado: false };
}

export async function criarMotorista(u: Usuario, d: DadosMotorista) {
  return db().begin((tx) => criarMotoristaTx(tx as unknown as Sql, u, d));
}

/**
 * Completa o motorista que chegou pela telemetria ("não cadastrado"). O
 * dispositivo continua mandando o mesmo ID: o vínculo é o hash já gravado, e
 * o código aqui é só o rótulo na dashboard (gerado do nome se não vier).
 */
async function completarMotoristaTx(tx: Sql, u: Usuario, id: string, d: z.infer<typeof schemaCompletarMotorista>) {
  uuid.parse(id);
  const provisoria = await empresaProvisoria(tx);
  const [m] = await tx`
    SELECT id, empresa_id, codigo FROM silver.motoristas
     WHERE id = ${id} AND (empresa_id = ${u.empresaId} OR empresa_id = ${provisoria}) AND arquivado_em IS NULL FOR UPDATE`;
  if (!m) throw naoEncontrado("Motorista");
  if (m.codigo) throw conflito("Este motorista já está cadastrado; use Editar.");
  const cod = d.codigo ?? (await codigoLivre(tx, u, codigoDoNome(d.nome), id));
  const [ocupado] = await tx`
    SELECT 1 FROM silver.motoristas WHERE empresa_id = ${u.empresaId} AND codigo = ${cod} AND arquivado_em IS NULL AND id <> ${id}`;
  if (ocupado) throw conflito(`O código ${cod} já está em uso.`);
  const [r] = await tx`
    UPDATE silver.motoristas SET ${tx(valoresMotorista(u, d, cod))}, status = ${d.status}::silver.status_motorista
     WHERE id = ${id} RETURNING id, codigo, nome_exibicao AS nome
  `;
  return r;
}

export async function completarMotorista(u: Usuario, id: string, d: z.infer<typeof schemaCompletarMotorista>) {
  return db().begin((tx) => completarMotoristaTx(tx as unknown as Sql, u, id, d));
}

/**
 * Edita. Trocar o código troca o hash: o dispositivo precisa passar a mandar
 * o código novo (a dashboard avisa).
 */
export async function atualizarMotorista(u: Usuario, id: string, d: z.infer<typeof schemaMotorista>) {
  uuid.parse(id);
  return db().begin(async (tx) => {
    const [atual] = await tx`SELECT id, codigo FROM silver.motoristas WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!atual) throw naoEncontrado("Motorista");
    let novoHash: string | null = null;
    if (d.codigo && d.codigo !== atual.codigo) {
      novoHash = hashMotorista(d.codigo);
      const [outro] = await tx`
        SELECT 1 FROM silver.motoristas
         WHERE id <> ${id} AND (motorista_hash = ${novoHash} OR (empresa_id = ${u.empresaId} AND codigo = ${d.codigo} AND arquivado_em IS NULL))`;
      if (outro) throw conflito(`O código ${d.codigo} já pertence a outro motorista.`);
    }
    const [m] = await tx`
      UPDATE silver.motoristas
         SET nome_exibicao = ${d.nome}, idade = ${d.idade ?? null}, anos_experiencia = ${d.anosExperiencia ?? null},
             categoria_cnh = ${d.categoriaCnh ?? null}, cnh_valida_ate = ${d.cnhValidaAte ?? null}::date,
             regiao_uf = ${d.regiaoUf ?? null}, status = ${d.status}::silver.status_motorista
             ${novoHash ? tx`, codigo = ${d.codigo!}, motorista_hash = ${novoHash}` : tx``}
       WHERE id = ${id}
      RETURNING id, codigo, nome_exibicao AS nome, status::text AS status
    `;
    return { ...m, codigoAlterado: !!novoHash };
  });
}

export async function excluirMotorista(u: Usuario, id: string): Promise<ResultadoExclusao> {
  uuid.parse(id);
  return db().begin(async (tx) => {
    const [m] = await tx`SELECT id FROM silver.motoristas WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!m) throw naoEncontrado("Motorista");
    const [h] = await tx`
      SELECT EXISTS (SELECT 1 FROM silver.turnos WHERE motorista_id = ${id})
          OR EXISTS (SELECT 1 FROM silver.alertas WHERE motorista_id = ${id})
          OR EXISTS (SELECT 1 FROM silver.incidentes WHERE motorista_id = ${id})
          OR EXISTS (SELECT 1 FROM silver.acoes_motorista WHERE motorista_id = ${id}) AS historico`;
    if (h.historico) {
      await tx`UPDATE silver.motoristas SET arquivado_em = now(), status = 'inativo' WHERE id = ${id}`;
      return { resultado: "arquivado" as const };
    }
    await tx`DELETE FROM silver.motoristas WHERE id = ${id}`;
    return { resultado: "excluido" as const };
  });
}

// ---------------------------------------------------------------------------
// Veículos
// ---------------------------------------------------------------------------

/** "abc-1d23" -> "ABC1D23": a mesma placa sempre vira o mesmo hash. */
export const normalizarPlaca = (placa: string) => placa.toUpperCase().replace(/[^A-Z0-9]/g, "");

const placa = z
  .string()
  .trim()
  .min(7)
  .max(10)
  .transform(normalizarPlaca)
  .refine((p) => /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p), "placa inválida (AAA1234 ou AAA1A23)");

export async function listarVeiculos(u: Usuario) {
  const sql = db();
  return sql`
    SELECT v.id, v.placa, v.tipo::text AS tipo, v.modelo, v.ano_fabricacao AS "anoFabricacao",
           v.capacidade_passageiros AS "capacidadePassageiros", v.ativo,
           d.id AS "dispositivoId", d.codigo AS "cameraCodigo", d.device_id AS "deviceId", d.status::text AS "cameraStatus",
           d.ultimo_contato_em AS "ultimoContatoEm", vd.inicio AS "cameraDesde",
           (EXISTS (SELECT 1 FROM silver.turnos t WHERE t.veiculo_id = v.id)
            OR EXISTS (SELECT 1 FROM silver.viagens vg WHERE vg.veiculo_id = v.id)
            OR EXISTS (SELECT 1 FROM silver.incidentes i WHERE i.veiculo_id = v.id)) AS "temHistorico"
      FROM silver.veiculos v
      LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.veiculo_id = v.id AND vd.fim IS NULL
      LEFT JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
     WHERE v.empresa_id = ${u.empresaId} AND v.arquivado_em IS NULL
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
export const schemaNovoVeiculo = z.object({ placa, ...camposVeiculo });
export const schemaVeiculo = z.object({ placa: placa.optional(), ...camposVeiculo });

type VeiculoCriado = { id: string; placa: string; tipo: string; reativado: boolean };

async function criarVeiculoTx(tx: Sql, u: Usuario, d: z.infer<typeof schemaNovoVeiculo>): Promise<VeiculoCriado> {
  const hash = sha256(d.placa);
  const [existe] = await tx`SELECT id, empresa_id, arquivado_em FROM silver.veiculos WHERE placa_hash = ${hash} FOR UPDATE`;
  if (existe && existe.empresa_id !== u.empresaId) throw conflito("Esta placa já está cadastrada em outra empresa.");
  if (existe && !existe.arquivado_em) throw conflito(`A placa ${d.placa} já está cadastrada.`);
  const valores = {
    tipo: d.tipo,
    modelo: d.modelo ?? null,
    ano_fabricacao: d.anoFabricacao ?? null,
    capacidade_passageiros: d.capacidadePassageiros ?? null,
    ativo: d.ativo,
  };
  if (existe) {
    // Placa excluída (arquivada) volta com o histórico.
    const [v] = await tx`
      UPDATE silver.veiculos SET tipo = ${valores.tipo}::silver.tipo_veiculo, modelo = ${valores.modelo},
             ano_fabricacao = ${valores.ano_fabricacao}, capacidade_passageiros = ${valores.capacidade_passageiros},
             ativo = ${valores.ativo}, placa = ${d.placa}, arquivado_em = NULL
       WHERE id = ${existe.id} RETURNING id, placa, tipo::text AS tipo`;
    return { ...(v as { id: string; placa: string; tipo: string }), reativado: true };
  }
  const [v] = await tx`
    INSERT INTO silver.veiculos (empresa_id, placa_hash, placa, tipo, modelo, ano_fabricacao, capacidade_passageiros, ativo)
    VALUES (${u.empresaId}, ${hash}, ${d.placa}, ${d.tipo}::silver.tipo_veiculo, ${valores.modelo}, ${valores.ano_fabricacao},
            ${valores.capacidade_passageiros}, ${d.ativo})
    RETURNING id, placa, tipo::text AS tipo
  `;
  return { ...(v as { id: string; placa: string; tipo: string }), reativado: false };
}

export async function criarVeiculo(u: Usuario, d: z.infer<typeof schemaNovoVeiculo>) {
  return db().begin((tx) => criarVeiculoTx(tx as unknown as Sql, u, d));
}

export async function atualizarVeiculo(u: Usuario, id: string, d: z.infer<typeof schemaVeiculo>) {
  uuid.parse(id);
  const sql = db();
  return sql.begin(async (tx) => {
    const [atual] = await tx`SELECT id, placa FROM silver.veiculos WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!atual) throw naoEncontrado("Veículo");
    const novaPlaca = d.placa && d.placa !== atual.placa ? d.placa : null;
    if (novaPlaca) {
      const [outro] = await tx`SELECT 1 FROM silver.veiculos WHERE id <> ${id} AND placa_hash = ${sha256(novaPlaca)}`;
      if (outro) throw conflito(`A placa ${novaPlaca} já está cadastrada.`);
    }
    const [v] = await tx`
      UPDATE silver.veiculos
         SET tipo = ${d.tipo}::silver.tipo_veiculo, modelo = ${d.modelo ?? null}, ano_fabricacao = ${d.anoFabricacao ?? null},
             capacidade_passageiros = ${d.capacidadePassageiros ?? null}, ativo = ${d.ativo}
             ${novaPlaca ? tx`, placa = ${novaPlaca}, placa_hash = ${sha256(novaPlaca)}` : tx``}
       WHERE id = ${id}
      RETURNING id, placa, tipo::text AS tipo, ativo
    `;
    // Veículo desativado não fica com câmera.
    if (!d.ativo) {
      await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fimAgora(tx as unknown as Sql)}, motivo = COALESCE(motivo, 'veículo desativado')
                WHERE veiculo_id = ${id} AND fim IS NULL`;
    }
    return v;
  });
}

export async function excluirVeiculo(u: Usuario, id: string): Promise<ResultadoExclusao> {
  uuid.parse(id);
  return db().begin(async (tx) => {
    const t = tx as unknown as Sql;
    const [v] = await tx`SELECT id FROM silver.veiculos WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!v) throw naoEncontrado("Veículo");
    const [h] = await tx`
      SELECT EXISTS (SELECT 1 FROM silver.turnos WHERE veiculo_id = ${id})
          OR EXISTS (SELECT 1 FROM silver.viagens WHERE veiculo_id = ${id} AND status <> 'planejada')
          OR EXISTS (SELECT 1 FROM silver.incidentes WHERE veiculo_id = ${id}) AS historico`;
    // A câmera sai do veículo e as viagens que ainda não aconteceram são canceladas.
    await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fimAgora(t)}, motivo = COALESCE(motivo, 'veículo excluído')
              WHERE veiculo_id = ${id} AND fim IS NULL`;
    if (h.historico) {
      await tx`UPDATE silver.viagens SET status = 'cancelada' WHERE veiculo_id = ${id} AND status = 'planejada'`;
      await tx`UPDATE silver.veiculos SET arquivado_em = now(), ativo = false WHERE id = ${id}`;
      return { resultado: "arquivado" as const };
    }
    await tx`DELETE FROM silver.veiculos WHERE id = ${id}`;
    return { resultado: "excluido" as const };
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
           um.id AS "ultimoMotoristaId", um.codigo AS "ultimoMotoristaCodigo", um.nome_exibicao AS "ultimoMotoristaNome",
           (um.id IS NOT NULL AND um.codigo IS NULL) AS "ultimoMotoristaPendente",
           EXISTS (SELECT 1 FROM silver.turnos t WHERE t.dispositivo_id = d.id) AS "temHistorico"
      FROM silver.dispositivos d
      LEFT JOIN silver.vinculos_dispositivo_veiculo vd ON vd.dispositivo_id = d.id AND vd.fim IS NULL
      LEFT JOIN silver.veiculos v ON v.id = vd.veiculo_id
      LEFT JOIN LATERAL (
          SELECT m.id, m.codigo, m.nome_exibicao FROM silver.turnos t JOIN silver.motoristas m ON m.id = t.motorista_id
           WHERE t.dispositivo_id = d.id ORDER BY t.iniciado_em DESC LIMIT 1
      ) um ON TRUE
     WHERE (d.empresa_id = ${u.empresaId} OR d.empresa_id IS NULL) AND d.arquivado_em IS NULL
     ORDER BY (d.empresa_id IS NULL) DESC, d.status, d.codigo NULLS LAST
  `;
}

const deviceId = z
  .string()
  .transform(normalizarDispositivo)
  .pipe(z.string().min(3, "use ao menos 3 letras ou números").max(64));
const codigoCamera = z
  .string()
  .transform((s) => normalizarId(s).toUpperCase())
  .pipe(z.string().min(2, "use ao menos 2 letras ou números").max(40));

export const schemaNovoDispositivo = z.object({
  deviceId,
  codigo: codigoCamera.optional().nullable(),
  descricao: textoOpcional(200),
});
export const schemaDispositivo = z.object({
  deviceId: deviceId.optional(),
  codigo: codigoCamera,
  descricao: textoOpcional(200),
  status: z.enum(["ativo", "pendente", "inativo"]),
});

async function codigoCameraLivre(tx: Sql, u: Usuario, cod: string, ignorar?: string) {
  const [ocupado] = await tx`
    SELECT 1 FROM silver.dispositivos WHERE empresa_id = ${u.empresaId} AND codigo = ${cod} AND arquivado_em IS NULL
       ${ignorar ? tx`AND id <> ${ignorar}` : tx``}`;
  if (ocupado) throw conflito(`O código ${cod} já está em outra câmera.`);
}

/** Cadastra a câmera ou assume a pendente (que já mandou dado) para a empresa. */
async function criarDispositivoTx(tx: Sql, u: Usuario, d: z.infer<typeof schemaNovoDispositivo>) {
  const [existe] = await tx`SELECT id, empresa_id, arquivado_em FROM silver.dispositivos WHERE device_id = ${d.deviceId} FOR UPDATE`;
  if (existe && existe.empresa_id && existe.empresa_id !== u.empresaId && !existe.arquivado_em) {
    throw conflito("Esta câmera pertence a outra empresa.");
  }
  const cod = d.codigo ?? d.deviceId.toUpperCase();
  await codigoCameraLivre(tx, u, cod, existe?.id);
  const [r] = await tx`
    INSERT INTO silver.dispositivos (empresa_id, device_id, codigo, descricao, status)
    VALUES (${u.empresaId}, ${d.deviceId}, ${cod}, ${d.descricao ?? null}, 'ativo')
    ON CONFLICT (device_id) DO UPDATE SET empresa_id = EXCLUDED.empresa_id, codigo = EXCLUDED.codigo, status = 'ativo',
                                          descricao = COALESCE(EXCLUDED.descricao, silver.dispositivos.descricao),
                                          arquivado_em = NULL
    RETURNING id, device_id AS "deviceId", codigo, status::text AS status
  `;
  return r;
}

export async function criarDispositivo(u: Usuario, d: z.infer<typeof schemaNovoDispositivo>) {
  return db().begin((tx) => criarDispositivoTx(tx as unknown as Sql, u, d));
}

async function dispositivoDaEmpresa(tx: Sql, u: Usuario, id: string, bloquear = false) {
  uuid.parse(id);
  const [d] = bloquear
    ? await tx`SELECT id, empresa_id, device_id FROM silver.dispositivos WHERE id = ${id} AND arquivado_em IS NULL FOR UPDATE`
    : await tx`SELECT id, empresa_id, device_id FROM silver.dispositivos WHERE id = ${id} AND arquivado_em IS NULL`;
  if (!d) throw naoEncontrado("Câmera");
  if (d.empresa_id && d.empresa_id !== u.empresaId) throw proibido("Esta câmera pertence a outra empresa.");
  return d;
}

/** Edita. Trocar o ID do dispositivo exige gravar o ID novo na câmera (a dashboard avisa). */
export async function atualizarDispositivo(u: Usuario, id: string, d: z.infer<typeof schemaDispositivo>) {
  const sql = db();
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const atual = await dispositivoDaEmpresa(t, u, id, true);
    const novoId = d.deviceId && d.deviceId !== atual.device_id ? d.deviceId : null;
    if (novoId) {
      const [outro] = await tx`SELECT 1 FROM silver.dispositivos WHERE device_id = ${novoId} AND id <> ${id}`;
      if (outro) throw conflito(`Já existe uma câmera com o ID ${novoId}.`);
    }
    await codigoCameraLivre(t, u, d.codigo, id);
    const [r] = await tx`
      UPDATE silver.dispositivos SET codigo = ${d.codigo}, descricao = ${d.descricao ?? null},
             status = ${d.status}::silver.status_dispositivo, empresa_id = ${u.empresaId}
             ${novoId ? tx`, device_id = ${novoId}` : tx``}
       WHERE id = ${id} RETURNING id, device_id AS "deviceId", codigo, status::text AS status
    `;
    if (d.status === "inativo") {
      await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fimAgora(t)}, motivo = COALESCE(motivo, 'câmera desativada')
                WHERE dispositivo_id = ${id} AND fim IS NULL`;
    }
    return { ...r, idAlterado: !!novoId };
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
async function vincularTx(tx: Sql, u: Usuario, id: string, d: z.infer<typeof schemaVinculo>) {
  await dispositivoDaEmpresa(tx, u, id, true);
  const [v] = await tx`SELECT id FROM silver.veiculos WHERE id = ${d.veiculoId} AND empresa_id = ${u.empresaId} AND ativo AND arquivado_em IS NULL FOR UPDATE`;
  if (!v) throw naoEncontrado("Veículo ativo");

  const [atual] = await tx`SELECT veiculo_id FROM silver.vinculos_dispositivo_veiculo WHERE dispositivo_id = ${id} AND fim IS NULL`;
  let novo: { id: string; inicio: string } | null = null;
  if (atual?.veiculo_id !== d.veiculoId) {
    await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fimAgora(tx)}, motivo = COALESCE(motivo, ${d.motivo ?? "troca de veículo"})
              WHERE fim IS NULL AND (dispositivo_id = ${id} OR veiculo_id = ${d.veiculoId})`;
    [novo] = (await tx`
      INSERT INTO silver.vinculos_dispositivo_veiculo (dispositivo_id, veiculo_id, inicio, motivo, criado_por)
      VALUES (${id}, ${d.veiculoId}, now(), ${d.motivo ?? null}, ${autor(u)})
      RETURNING id, inicio
    `) as unknown as { id: string; inicio: string }[];
  }
  await tx`UPDATE silver.dispositivos SET empresa_id = ${u.empresaId}, status = 'ativo' WHERE id = ${id}`;

  // Motoristas que só apareceram por esta câmera (empresa provisória) passam para a empresa.
  const provisoria = await empresaProvisoria(tx);
  if (provisoria) {
    await tx`
      UPDATE silver.motoristas SET empresa_id = ${u.empresaId}
       WHERE empresa_id = ${provisoria}
         AND id IN (SELECT motorista_id FROM silver.turnos WHERE dispositivo_id = ${id})
    `;
  }
  return { dispositivoId: id, veiculoId: d.veiculoId, vinculoId: novo?.id ?? null, inicio: novo?.inicio ?? null, alterado: !!novo };
}

export async function vincularDispositivo(u: Usuario, id: string, d: z.infer<typeof schemaVinculo>) {
  return db().begin((tx) => vincularTx(tx as unknown as Sql, u, id, d));
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

/** Câmera pendente que nunca mandou turno some de vez; com turnos, é arquivada. */
export async function excluirDispositivo(u: Usuario, id: string): Promise<ResultadoExclusao> {
  return db().begin(async (tx) => {
    const t = tx as unknown as Sql;
    await dispositivoDaEmpresa(t, u, id, true);
    const [h] = await tx`SELECT EXISTS (SELECT 1 FROM silver.turnos WHERE dispositivo_id = ${id}) AS historico`;
    await tx`UPDATE silver.vinculos_dispositivo_veiculo SET fim = ${fimAgora(t)}, motivo = COALESCE(motivo, 'câmera excluída')
              WHERE dispositivo_id = ${id} AND fim IS NULL`;
    if (h.historico) {
      await tx`UPDATE silver.dispositivos SET arquivado_em = now(), status = 'inativo' WHERE id = ${id}`;
      return { resultado: "arquivado" as const };
    }
    await tx`DELETE FROM silver.dispositivos WHERE id = ${id}`;
    return { resultado: "excluido" as const };
  });
}

// ---------------------------------------------------------------------------
// Assistente: câmera + veículo + motorista de uma vez
// ---------------------------------------------------------------------------

export const schemaOperacao = z.object({
  camera: z
    .object({
      dispositivoId: uuid.optional().nullable(),
      deviceId: deviceId.optional().nullable(),
      codigo: codigoCamera.optional().nullable(),
      descricao: textoOpcional(200),
    })
    .refine((c) => c.dispositivoId || c.deviceId, "escolha uma câmera ou informe o ID do dispositivo"),
  veiculo: z
    .object({
      veiculoId: uuid.optional().nullable(),
      placa: placa.optional().nullable(),
      tipo: z.enum(TIPOS_VEICULO).optional(),
      modelo: textoOpcional(80),
      anoFabricacao: z.number().int().min(1980).max(2100).nullable().optional(),
      capacidadePassageiros: z.number().int().min(0).max(200).nullable().optional(),
    })
    .refine((v) => v.veiculoId || v.placa, "escolha um veículo ou informe a placa"),
  motorista: z
    .object({
      motoristaId: uuid.optional().nullable(),
      codigo: codigo().optional().nullable(),
      ...camposMotorista,
      nome: camposMotorista.nome.optional(),
    })
    .refine((m) => m.motoristaId || m.nome, "escolha um motorista ou informe o nome")
    .optional()
    .nullable(),
});

/**
 * O fluxo de "colocar uma câmera em operação" numa transação só: cria ou
 * escolhe o veículo, cadastra (ou assume a pendente) a câmera e instala, e
 * cria, escolhe ou completa o motorista. Devolve o que gravar no dispositivo.
 */
export async function operacao(u: Usuario, d: z.infer<typeof schemaOperacao>) {
  return db().begin(async (tx) => {
    const t = tx as unknown as Sql;

    // 1. Veículo
    let veiculo: { id: string; placa: string };
    if (d.veiculo.veiculoId) {
      // Colocar uma câmera num veículo inativo o reativa.
      const [v] = await tx`
        UPDATE silver.veiculos SET ativo = true
         WHERE id = ${d.veiculo.veiculoId} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL
        RETURNING id, placa`;
      if (!v) throw naoEncontrado("Veículo");
      veiculo = v as unknown as typeof veiculo;
    } else {
      const v = await criarVeiculoTx(t, u, {
        placa: d.veiculo.placa!,
        tipo: d.veiculo.tipo ?? "caminhao",
        modelo: d.veiculo.modelo ?? null,
        anoFabricacao: d.veiculo.anoFabricacao ?? null,
        capacidadePassageiros: d.veiculo.capacidadePassageiros ?? null,
        ativo: true,
      });
      veiculo = { id: v.id, placa: v.placa };
    }

    // 2. Câmera (nova, pendente ou já da empresa) e instalação no veículo
    let cameraId: string;
    let cameraDeviceId: string;
    const codigoCam = d.camera.codigo ?? normalizarId(veiculo.placa).toUpperCase();
    if (d.camera.dispositivoId) {
      const atual = await dispositivoDaEmpresa(t, u, d.camera.dispositivoId, true);
      await codigoCameraLivre(t, u, codigoCam, atual.id);
      await tx`UPDATE silver.dispositivos SET empresa_id = ${u.empresaId}, codigo = ${codigoCam}, status = 'ativo',
                      descricao = COALESCE(${d.camera.descricao ?? null}, descricao)
                WHERE id = ${atual.id}`;
      cameraId = atual.id;
      cameraDeviceId = atual.device_id;
    } else {
      const c = await criarDispositivoTx(t, u, { deviceId: d.camera.deviceId!, codigo: codigoCam, descricao: d.camera.descricao ?? null });
      cameraId = c.id;
      cameraDeviceId = c.deviceId;
    }
    await vincularTx(t, u, cameraId, { veiculoId: veiculo.id, motivo: "colocada em operação" });

    // 3. Motorista (opcional): existente, completar o que chegou pela telemetria ou novo
    let motorista: { id: string; codigo: string | null; nome: string; idDoDispositivo: string | null } | null = null;
    if (d.motorista) {
      const m = d.motorista;
      if (m.motoristaId) {
        const provisoria = await empresaProvisoria(t);
        const [atual] = await tx`
          SELECT id, codigo, nome_exibicao FROM silver.motoristas
           WHERE id = ${m.motoristaId} AND (empresa_id = ${u.empresaId} OR empresa_id = ${provisoria}) AND arquivado_em IS NULL`;
        if (!atual) throw naoEncontrado("Motorista");
        if (!atual.codigo && m.nome) {
          const r = await completarMotoristaTx(t, u, atual.id, { ...m, nome: m.nome, codigo: m.codigo ?? null });
          // O dispositivo já manda o ID dele: nada a mudar lá.
          motorista = { id: r.id, codigo: r.codigo, nome: r.nome, idDoDispositivo: null };
        } else {
          motorista = { id: atual.id, codigo: atual.codigo, nome: atual.nome_exibicao, idDoDispositivo: atual.codigo };
        }
      } else {
        const r = await criarMotoristaTx(t, u, { ...m, nome: m.nome!, codigo: m.codigo ?? null });
        motorista = { id: r.id, codigo: r.codigo, nome: r.nome, idDoDispositivo: r.codigo };
      }
    }

    return {
      veiculo,
      camera: { id: cameraId, deviceId: cameraDeviceId, codigo: codigoCam },
      motorista,
      // O que gravar no .env do dispositivo (repositório ML).
      configuracao: {
        DRIVEGUARD_DEVICE_ID: cameraDeviceId,
        DRIVEGUARD_MOTORISTA_ID: motorista?.idDoDispositivo ?? null,
      },
    };
  });
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
           (SELECT COUNT(*)::int FROM silver.viagens vg WHERE vg.rota_id = r.id AND vg.arquivado_em IS NULL) AS viagens,
           EXISTS (SELECT 1 FROM silver.viagens vg WHERE vg.rota_id = r.id AND vg.status <> 'planejada') AS "temHistorico"
      FROM silver.rotas r WHERE empresa_id = ${u.empresaId} AND arquivado_em IS NULL
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
     WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL
    RETURNING id
  `;
  if (!r) throw naoEncontrado("Rota");
  return r;
}

/** Rota com viagens feitas é arquivada; as planejadas dela são canceladas. */
export async function excluirRota(u: Usuario, id: string): Promise<ResultadoExclusao> {
  uuid.parse(id);
  return db().begin(async (tx) => {
    const [r] = await tx`SELECT id FROM silver.rotas WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!r) throw naoEncontrado("Rota");
    const [h] = await tx`
      SELECT EXISTS (SELECT 1 FROM silver.viagens vg WHERE vg.rota_id = ${id}
                       AND (vg.status <> 'planejada' OR EXISTS (SELECT 1 FROM silver.turnos t WHERE t.viagem_id = vg.id))) AS historico`;
    if (h.historico) {
      await tx`UPDATE silver.viagens SET status = 'cancelada' WHERE rota_id = ${id} AND status = 'planejada'`;
      await tx`UPDATE silver.rotas SET arquivado_em = now(), ativo = false WHERE id = ${id}`;
      return { resultado: "arquivado" as const };
    }
    await tx`DELETE FROM silver.rotas WHERE id = ${id}`;
    return { resultado: "excluido" as const };
  });
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
     WHERE vg.empresa_id = ${u.empresaId} AND vg.arquivado_em IS NULL
       AND vg.partida_prevista >= now() - make_interval(days => ${f.dias})
       ${f.status ? sql`AND vg.status = ${f.status}::silver.status_viagem` : sql``}
       ${f.veiculo_id ? sql`AND vg.veiculo_id = ${f.veiculo_id}` : sql``}
     ORDER BY vg.partida_prevista DESC
     LIMIT 500
  `;
}

async function validarReferencias(sql: Sql, u: Usuario, d: z.infer<typeof schemaViagem>) {
  const [ok] = await sql`
    SELECT (SELECT COUNT(*) FROM silver.rotas WHERE id = ${d.rotaId} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL)::int AS rota,
           (SELECT COUNT(*) FROM silver.veiculos WHERE id = ${d.veiculoId} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL)::int AS veiculo,
           (SELECT COUNT(*) FROM silver.motoristas WHERE id = ${d.motoristaId ?? null} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL)::int AS motorista
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
     WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL
    RETURNING id
  `;
  if (!r) throw naoEncontrado("Viagem");
  return r;
}

/** Viagem com turnos casados é arquivada (o turno guarda a origem e o destino dela). */
export async function excluirViagem(u: Usuario, id: string): Promise<ResultadoExclusao> {
  uuid.parse(id);
  return db().begin(async (tx) => {
    const [v] = await tx`SELECT id FROM silver.viagens WHERE id = ${id} AND empresa_id = ${u.empresaId} AND arquivado_em IS NULL FOR UPDATE`;
    if (!v) throw naoEncontrado("Viagem");
    const [h] = await tx`SELECT EXISTS (SELECT 1 FROM silver.turnos WHERE viagem_id = ${id}) AS historico`;
    if (h.historico) {
      await tx`UPDATE silver.viagens SET arquivado_em = now() WHERE id = ${id}`;
      return { resultado: "arquivado" as const };
    }
    await tx`DELETE FROM silver.viagens WHERE id = ${id}`;
    return { resultado: "excluido" as const };
  });
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
