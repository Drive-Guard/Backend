/** Ambiente de cada arquivo de teste: banco de teste, arquivos locais, usuários em memória. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.DG_TEST_PG ?? "postgres://postgres:postgres@localhost:54329";
process.env.DATABASE_URL = `${BASE}/driveguard_backend_test`;
process.env.DB_SSL = "false";
process.env.ARQUIVOS_DIR = mkdtempSync(join(tmpdir(), "dg-arquivos-"));
process.env.USUARIOS_DEV = "1";
process.env.SITE_URL = "http://localhost:8080";
process.env.IA_API_KEY = "";
