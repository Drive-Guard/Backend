// Empacota as Lambdas com esbuild em dist/<função>/index.js.
//
// - Um bundle por Lambda da API e um para todos os workers.
// - O AWS SDK v3 fica de fora: já vem no runtime nodejs22.x.
// - As funções que falam com o RDS levam o bundle de CAs do RDS, usado para
//   validar o TLS do banco (src/lib/db.ts).

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(raiz, "dist");
const cache = join(raiz, ".cache");
const CA_URL = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";

const FUNCOES = [
  { nome: "dashboard", banco: true },
  { nome: "motoristas", banco: true },
  { nome: "alertas", banco: true },
  { nome: "relatorios", banco: true },
  { nome: "cadastros", banco: true },
  { nome: "usuarios", banco: false },
  { nome: "workers", banco: true },
];

async function bundleCa() {
  const destino = join(cache, "rds-ca-bundle.pem");
  if (existsSync(destino) && statSync(destino).size > 1000) return destino;
  mkdirSync(cache, { recursive: true });
  console.log("--> Baixando o bundle de CAs do RDS");
  const r = await fetch(CA_URL);
  if (!r.ok) throw new Error(`Falha ao baixar ${CA_URL}: ${r.status}`);
  const texto = await r.text();
  if (!texto.includes("BEGIN CERTIFICATE")) throw new Error("Bundle de CAs inválido");
  writeFileSync(destino, texto);
  return destino;
}

rmSync(dist, { recursive: true, force: true });
const ca = await bundleCa();

for (const f of FUNCOES) {
  const saida = join(dist, f.nome);
  const r = await build({
    entryPoints: [join(raiz, "src", "funcoes", `${f.nome}.ts`)],
    outfile: join(saida, "index.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: true,
    minify: true,
    keepNames: true,
    external: ["@aws-sdk/*"],
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  if (f.banco) copyFileSync(ca, join(saida, "rds-ca-bundle.pem"));
  const bytes = Object.values(r.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
  console.log(`    ok - ${f.nome.padEnd(12)} ${(bytes / 1024).toFixed(0)} KB`);
}

console.log("==> Build concluído em dist/. Rode `npx osls deploy --stage dev`.");
