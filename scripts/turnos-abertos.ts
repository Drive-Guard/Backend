/** Grava em JSON os turnos abertos (código -> início em UTC), para conferir com o simulador. */
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { URL_LOCAL } from "./migrar";

const sql = postgres(process.env.DATABASE_URL ?? URL_LOCAL, { max: 1 });

async function main() {
  const linhas = await sql<{ codigo: string; inicio: string }[]>`
    SELECT m.codigo, to_char(t.iniciado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS inicio
      FROM silver.turnos t JOIN silver.motoristas m ON m.id = t.motorista_id
     WHERE t.status = 'em_andamento' ORDER BY 1`;
  writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(linhas.map((l) => [l.codigo, l.inicio]))));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
