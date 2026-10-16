// Sobe um PostgreSQL 16 local (binários reais, sem Docker) para desenvolver e
// rodar os testes do Backend e do Infra contra a mesma versão do RDS.
//
//   npm run db:local            -> porta 54329, dados em .pgdata/
//   DB_LOCAL_PORT=5433 npm run db:local
//
// O processo fica de pé até Ctrl+C. A URL de conexão é impressa ao subir.

import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.DB_LOCAL_PORT ?? 54329);
const databaseDir = resolve(process.env.DB_LOCAL_DIR ?? ".pgdata");
const user = "postgres";
const password = "postgres";
const database = process.env.DB_LOCAL_NAME ?? "driveguard";

// UTF8 e ICU pt-BR como no RDS: sem isso o initdb usa a codificação do
// Windows (WIN1252), e com locale C o lower() não trata letras acentuadas.
const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--locale-provider=icu", "--icu-locale=pt-BR"],
});

if (!existsSync(resolve(databaseDir, "PG_VERSION"))) {
  console.log(`Inicializando cluster em ${databaseDir}`);
  await pg.initialise();
}

await pg.start();

const client = pg.getPgClient();
await client.connect();
const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (rowCount === 0) {
  await client.query(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8' ` +
      `LOCALE_PROVIDER icu ICU_LOCALE 'pt-BR' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
}
await client.end();

console.log(`\nPostgreSQL local no ar:\n  postgres://${user}:${password}@localhost:${port}/${database}\n`);
console.log("Ctrl+C para parar.");

const parar = async () => {
  console.log("\nParando o PostgreSQL...");
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", parar);
process.on("SIGTERM", parar);

// Mantém o processo vivo.
setInterval(() => {}, 1 << 30);
