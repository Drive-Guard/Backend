/**
 * Gera uma rodada de insights com a IA de verdade contra o banco local, sem
 * gravar: mostra o que o Gemini devolve para o contexto atual.
 *
 *   IA_API_KEY=... npx tsx scripts/testar-ia.ts [7d|30d|90d]
 */
import { montarContexto } from "../src/servicos/insights/contexto";
import { gerarInsights } from "../src/servicos/insights/ia";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:54329/driveguard";

async function main() {
  const periodo = process.argv[2] ?? "30d";
  const ctx = await montarContexto("00000000-0000-4000-8000-000000000001", undefined, { periodo });
  const inicio = Date.now();
  const r = await gerarInsights(ctx);
  console.log(JSON.stringify({ status: r.status, modelo: r.modelo, erro: r.erro, segundos: (Date.now() - inicio) / 1000, tokens: [r.tokensEntrada, r.tokensSaida] }));
  for (const rec of r.recomendacoes) console.log(`\n[${rec.severidade}] ${rec.titulo}\n  ${rec.descricao}\n  -> ${rec.acao_sugerida}`);
  console.log("\nResumo:\n- " + r.resumo.join("\n- "));
  for (const m of r.motoristas) console.log(`\n${m.codigo} [${m.severidade}] ${m.titulo}: ${m.descricao}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
