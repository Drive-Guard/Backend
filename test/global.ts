/**
 * Prepara o banco de teste uma vez por execução: cria driveguard_backend_test
 * no PostgreSQL local (npm run db:local), aplica os scripts SQL do Infra com
 * o seed e carrega uma amostra da base da PRF.
 *
 * Sem PostgreSQL local os testes falham na hora, com a instrução de como subir.
 */

import postgres from "postgres";
import { migrar } from "../scripts/migrar";

export const BANCO_TESTE = "driveguard_backend_test";
const BASE = process.env.DG_TEST_PG ?? "postgres://postgres:postgres@localhost:54329";

/** Amostra da PRF: acidentes com e sem sono, de pesados e leves, em BRs das rotas do seed. */
const AMOSTRA_PRF = `
INSERT INTO silver.incidentes (origem, origem_id_externo, ocorrido_em, uf, municipio, br, km, latitude, longitude,
                               causa, tipo_acidente, gravidade, qtd_mortos, qtd_feridos, relacionado_sonolencia, fonte_arquivo)
SELECT 'prf', 'T' || g, now() - make_interval(days => 30 + g % 200) - make_interval(hours => g % 24),
       (ARRAY['SP','RJ','MG','BA','PR'])[1 + g % 5], (ARRAY['GUARULHOS','RESENDE','BETIM','FEIRA DE SANTANA','CURITIBA'])[1 + g % 5],
       (ARRAY['116','116','381','116','376'])[1 + g % 5], (g * 7) % 400,
       -20 - (g % 5), -45 - (g % 4),
       CASE WHEN g % 4 = 0 THEN 'Condutor Dormindo' WHEN g % 4 = 1 THEN 'Velocidade Incompatível' ELSE 'Reação tardia ou ineficiente do condutor' END,
       'Colisão traseira',
       (CASE WHEN g % 10 = 0 THEN 'com_fatais' WHEN g % 3 = 0 THEN 'com_feridos' ELSE 'sem_vitimas' END)::silver.gravidade_incidente,
       CASE WHEN g % 10 = 0 THEN 1 ELSE 0 END, CASE WHEN g % 3 = 0 THEN 2 ELSE 0 END,
       g % 4 = 0, 'teste'
  FROM generate_series(1, 400) g;
INSERT INTO silver.incidentes_veiculos (incidente_id, tipo_veiculo, quantidade)
SELECT id, CASE WHEN substr(origem_id_externo, 2)::int % 2 = 0 THEN 'Caminhão' ELSE 'Automóvel' END, 1
  FROM silver.incidentes WHERE origem = 'prf';
INSERT INTO silver.prf_cargas (conjunto, ano, s3_key, etag, status, concluido_em)
VALUES ('ocorrencias', 2025, 'teste', 'teste', 'ok', now());
`;

export default async function () {
  const adm = postgres(`${BASE}/postgres`, { max: 1, onnotice: () => undefined });
  try {
    await adm`SELECT 1`;
  } catch (e) {
    throw new Error(`PostgreSQL de teste indisponível em ${BASE}. Rode \`npm run db:local\` em outro terminal. (${(e as Error).message})`);
  }
  await adm.unsafe(`DROP DATABASE IF EXISTS ${BANCO_TESTE} WITH (FORCE)`);
  await adm.unsafe(
    `CREATE DATABASE ${BANCO_TESTE} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'pt-BR' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  await adm.end();

  const url = `${BASE}/${BANCO_TESTE}`;
  await migrar(url, { log: false });

  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  await sql.unsafe(AMOSTRA_PRF).simple();
  for (const v of ["mv_prf_faixa_horaria", "mv_prf_causas_mes", "mv_prf_hotspots", "mv_prf_trechos", "mv_prf_perfil_sono"]) {
    await sql.unsafe(`REFRESH MATERIALIZED VIEW gold.${v}`);
  }
  await sql.end();
}
