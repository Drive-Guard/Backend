/**
 * Gera um relatório de exemplo a partir do banco local, para conferir o
 * layout sem subir nada:
 *
 *   npx tsx scripts/exemplo-relatorio.ts executivo pdf saida.pdf
 */

import { writeFileSync } from "node:fs";
import { usuarioSistema } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { contexto, documento } from "../src/servicos/relatorios/dados";
import type { Formato, TipoRelatorio } from "../src/servicos/relatorios/documento";
import { renderizar } from "../src/servicos/relatorios";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:54329/driveguard";
process.env.DB_SSL = "false";

async function principal() {
  const [tipo = "executivo", formato = "pdf", saida = `exemplo-${tipo}.${formato}`] = process.argv.slice(2);
  const c = contexto(usuarioSistema("00000000-0000-4000-8000-000000000001"), { periodo: "30d" });
  const doc = await documento(c, tipo as TipoRelatorio);
  writeFileSync(saida, await renderizar(doc, formato as Formato));
  console.log(`Gerado ${saida}`);
  await db().end();
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
