/**
 * Aplica os scripts SQL do repositório Infra num banco (o mesmo que a Lambda
 * db_migrate faz no RDS): um arquivo por transação, em ordem alfabética.
 *
 *   npm run db:migrar                  # banco local (npm run db:local)
 *   npm run db:resemear                # apaga a frota e roda o seed de novo
 *                                      # (a base da PRF carregada fica)
 *   DATABASE_URL=... INFRA_SQL_DIR=... npx tsx scripts/migrar.ts
 *
 * O seed só entra se o banco ainda não tem empresa (ele mesmo se protege).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

// Os scripts npm rodam na raiz do Backend; o Infra fica ao lado.
export const SQL_DIR = resolve(process.env.INFRA_SQL_DIR ?? join(process.cwd(), "..", "Infra", "sql"));
export const URL_LOCAL = "postgres://postgres:postgres@localhost:54329/driveguard";

export async function migrar(url: string, opcoes: { seed?: boolean; log?: boolean; resemear?: boolean } = {}) {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    if (opcoes.resemear) {
      // DELETE (e não TRUNCATE): respeita o ON DELETE SET NULL dos acidentes
      // da PRF, que não têm empresa e ficam.
      await sql.begin(async (tx) => {
        const [tem] = await tx`SELECT to_regclass('silver.dispositivos') IS NOT NULL AS ok`;
        if (tem.ok) {
          await tx`DELETE FROM silver.incidentes WHERE origem = 'interno'`;
          await tx`DELETE FROM silver.dispositivos`;
          await tx`DELETE FROM silver.empresas`;
        }
      });
    }
    const arquivos = readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const arquivo of arquivos) {
      if (arquivo.includes("seed") && opcoes.seed === false) continue;
      const inicio = Date.now();
      await sql.begin((tx) => tx.unsafe(readFileSync(join(SQL_DIR, arquivo), "utf8")).simple());
      if (opcoes.log !== false) console.log(`  ${arquivo.padEnd(24)} ${Date.now() - inicio} ms`);
    }
  } finally {
    await sql.end();
  }
}

if (typeof require !== "undefined" && require.main === module) {
  const url = process.env.DATABASE_URL ?? URL_LOCAL;
  const resemear = process.argv.includes("--resemear");
  console.log(`Aplicando ${SQL_DIR} em ${url.replace(/:[^:@/]+@/, ":***@")}${resemear ? " (resemeando)" : ""}`);
  migrar(url, { seed: process.env.SEED !== "false", resemear })
    .then(() => console.log("Migração concluída."))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
