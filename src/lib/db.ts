/**
 * Conexão com o PostgreSQL (RDS em produção, PostgreSQL local nos testes).
 *
 * Um cliente por container da Lambda, reaproveitado entre invocações. Cada
 * container atende uma requisição por vez, então o pool é pequeno: duas
 * conexões bastam para as consultas em paralelo de uma mesma rota e não
 * estouram o max_connections de um db.t3.micro.
 *
 * Em produção o TLS é validado contra o bundle de CAs do RDS, copiado para o
 * pacote pelo scripts/build.mjs. Sem o bundle a função falha em vez de
 * desligar a verificação.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, unknown>>;

let cliente: Sql | null = null;

function opcoesTls(): postgres.Options<Record<string, never>>["ssl"] {
  if (process.env.DB_SSL === "false") return false;
  const bundle = join(__dirname, "rds-ca-bundle.pem");
  if (!existsSync(bundle)) {
    throw new Error("rds-ca-bundle.pem não está no pacote. Rode `npm run build` antes do deploy.");
  }
  return { ca: readFileSync(bundle, "utf8"), rejectUnauthorized: true };
}

/** Converte numeric e bigint em number: os valores daqui são métricas, não dinheiro de banco. */
const tipos = {
  numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
};

export function criarCliente(url?: string): Sql {
  const comum = {
    max: Number(process.env.DB_POOL ?? 2),
    idle_timeout: 60,
    max_lifetime: 60 * 15,
    connect_timeout: 10,
    prepare: true,
    types: tipos,
    connection: { application_name: process.env.AWS_LAMBDA_FUNCTION_NAME ?? "driveguard-backend" },
  };

  if (url) return postgres(url, { ...comum, ssl: false }) as unknown as Sql;

  return postgres({
    ...comum,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: opcoesTls(),
  }) as unknown as Sql;
}

export function db(): Sql {
  if (!cliente) cliente = criarCliente(process.env.DATABASE_URL);
  return cliente;
}

/** Usado pelos testes para apontar o módulo para o banco de teste. */
export function definirCliente(novo: Sql | null): void {
  cliente = novo;
}
