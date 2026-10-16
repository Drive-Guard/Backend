/**
 * Servidor de desenvolvimento: roda as MESMAS Lambdas da API contra o
 * PostgreSQL local, sem AWS.
 *
 *   npm run db:local          # outro terminal: PostgreSQL 16 em localhost:54329
 *   npm run dev:api           # http://localhost:3001 (aplica as migrações ao subir)
 *
 * O que muda em relação à nuvem:
 *   - login: em vez do ID token do Cognito, o front manda "Bearer dev:<papel>"
 *     (admin, gestor ou operador). Só existe aqui;
 *   - S3: os arquivos vão para .arquivos/ e a cadeia que o EventBridge faria
 *     (insights, envio de relatório) roda na hora;
 *   - usuários: ficam em memória (sem Cognito).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const PORTA = Number(process.env.PORT ?? 3001);
const RAIZ = resolve(__dirname, "..");
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:54329/driveguard";
process.env.DB_SSL = "false";
process.env.ARQUIVOS_DIR ??= join(RAIZ, ".arquivos");
process.env.USUARIOS_DEV = "1";
process.env.DEV_API_URL ??= `http://localhost:${PORTA}`;
process.env.SITE_URL ??= "http://localhost:8080";

const EMPRESA_DEMO = "00000000-0000-4000-8000-000000000001";
const USUARIOS_DEV: Record<string, { sub: string; email: string; name: string }> = {
  admin: { sub: "00000000-0000-4000-9000-00000000000a", email: "admin@dev.local", name: "Admin (dev)" },
  gestor: { sub: "00000000-0000-4000-9000-00000000000b", email: "gestor@dev.local", name: "Gestor (dev)" },
  operador: { sub: "00000000-0000-4000-9000-00000000000c", email: "operador@dev.local", name: "Operador (dev)" },
};

async function principal() {
  const { migrar } = await import("./migrar");
  if (process.env.MIGRAR !== "false") {
    console.log("Aplicando as migrações do Infra no banco local...");
    await migrar(process.env.DATABASE_URL!, { log: false });
  }

  const { rotas } = await import("../src/rotas");
  const { aoGravarLocal } = await import("../src/lib/arquivos");
  const workers = await import("../src/funcoes/workers");
  const handlers: Record<string, (e: unknown) => Promise<APIGatewayProxyStructuredResultV2>> = {
    dashboard: (await import("../src/funcoes/dashboard")).handler as never,
    motoristas: (await import("../src/funcoes/motoristas")).handler as never,
    alertas: (await import("../src/funcoes/alertas")).handler as never,
    relatorios: (await import("../src/funcoes/relatorios")).handler as never,
    cadastros: (await import("../src/funcoes/cadastros")).handler as never,
    usuarios: (await import("../src/funcoes/usuarios")).handler as never,
  };

  // O EventBridge, localmente: cada arquivo gravado dispara o próximo passo.
  const eventoS3 = (chave: string) => ({ detail: { bucket: { name: "local" }, object: { key: chave } } });
  aoGravarLocal(async (chave) => {
    const passo =
      chave.startsWith("insights/contextos/") ? workers.insightsIa
      : chave.startsWith("insights/respostas/") ? workers.insightsGravar
      : chave.startsWith("relatorios/envios/") ? workers.relatorioEnviar
      : chave.startsWith("relatorios/resultados/") ? workers.relatorioStatus
      : null;
    if (passo) setImmediate(() => passo(eventoS3(chave) as never).catch((e) => console.error("worker local:", e)));
  });

  const tabela = rotas.map((r) => ({
    rota: r,
    regex: new RegExp(`^${r.caminho.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`),
  }));

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };

  const servidor = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORTA}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }

    // Downloads dos relatórios gerados localmente.
    if (url.pathname.startsWith("/arquivos/")) {
      const caminho = normalize(join(process.env.ARQUIVOS_DIR!, decodeURIComponent(url.pathname.slice("/arquivos/".length))));
      if (!caminho.startsWith(normalize(process.env.ARQUIVOS_DIR!)) || !existsSync(caminho)) {
        res.writeHead(404, cors).end();
        return;
      }
      res.writeHead(200, { ...cors, "Content-Disposition": "attachment" }).end(readFileSync(caminho));
      return;
    }

    if (req.method === "POST" && url.pathname === "/_dev/agendamentos") {
      const feitos = await workers.agendamentos();
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(feitos));
      return;
    }

    const achado = tabela.find((t) => t.rota.metodo === req.method && t.regex.test(url.pathname));
    if (!achado) {
      res.writeHead(404, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ erro: "Rota não encontrada" }));
      return;
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const papel = token.startsWith("dev:") ? token.slice(4) : "";
    const dev = USUARIOS_DEV[papel];
    if (!dev) {
      res.writeHead(401, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }

    const corpo = await new Promise<string>((ok) => {
      let dados = "";
      req.on("data", (c) => (dados += c));
      req.on("end", () => ok(dados));
    });

    const evento = {
      routeKey: `${achado.rota.metodo} ${achado.rota.caminho}`,
      rawPath: url.pathname,
      pathParameters: achado.regex.exec(url.pathname)?.groups ?? {},
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: corpo || undefined,
      isBase64Encoded: false,
      requestContext: {
        authorizer: {
          jwt: {
            claims: { ...dev, "custom:empresa_id": EMPRESA_DEMO, "cognito:groups": `[${papel}]` },
            scopes: null,
          },
        },
      },
    };

    const r = await handlers[achado.rota.funcao](evento);
    res.writeHead(r.statusCode ?? 200, { ...cors, ...(r.headers as Record<string, string>) }).end(r.body ?? "");
  });

  servidor.listen(PORTA, () => {
    console.log(`\nAPI de desenvolvimento em http://localhost:${PORTA}  (${rotas.length} rotas)`);
    console.log('Autenticação: "Authorization: Bearer dev:admin" | dev:gestor | dev:operador\n');
  });
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
