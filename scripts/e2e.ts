/**
 * Teste de ponta a ponta do Backend: todas as rotas, por papel, inclusive as
 * que gravam (cadastros, ações, relatórios, agendamentos, insights, usuários).
 *
 *   npx tsx scripts/e2e.ts local     # servidor de desenvolvimento (npm run dev:api)
 *   npx tsx scripts/e2e.ts aws       # Lambdas implantadas (credenciais da AWS no ambiente)
 *
 * Na AWS as Lambdas são invocadas direto com o evento que o API Gateway
 * entrega depois do autorizador JWT (claims de um usuário da empresa de
 * demonstração). Assim o teste não precisa de senha de usuário; a validação
 * do token pelo autorizador é conferida à parte (401 sem token).
 *
 * O que o teste cria leva o prefixo E2E e fica marcado como inativo/cancelado.
 */

import { rotas, type FuncaoApi } from "../src/rotas";

const alvo = (process.argv[2] ?? "local") as "local" | "aws";
const EMPRESA = "00000000-0000-4000-8000-000000000001";
const STAGE = process.env.STAGE ?? "dev";
const sufixo = Date.now().toString(36).slice(-5).toUpperCase();

type Papel = "admin" | "gestor" | "operador";
interface Resp {
  status: number;
  corpo: any;
}

const tabela = rotas.map((r) => ({ r, re: new RegExp(`^${r.caminho.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`) }));

// ---------------------------------------------------------------- transporte

async function viaHttp(papel: Papel, metodo: string, caminho: string, query?: Record<string, string>, corpo?: unknown): Promise<Resp> {
  const url = new URL((process.env.API_URL ?? "http://localhost:3001") + caminho);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: metodo,
    headers: { Authorization: `Bearer dev:${papel}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let dados: any = texto;
  try {
    dados = JSON.parse(texto);
  } catch {
    /* CSV */
  }
  return { status: r.status, corpo: dados };
}

let lambda: import("@aws-sdk/client-lambda").LambdaClient | null = null;
async function viaLambda(papel: Papel, metodo: string, caminho: string, query?: Record<string, string>, corpo?: unknown): Promise<Resp> {
  const achado = tabela.find((t) => t.r.metodo === metodo && t.re.test(caminho));
  if (!achado) throw new Error(`Rota fora do manifesto: ${metodo} ${caminho}`);
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  lambda ??= new LambdaClient({});
  const ids: Record<Papel, string> = { admin: "a", gestor: "b", operador: "c" };
  const evento = {
    version: "2.0",
    routeKey: `${metodo} ${achado.r.caminho}`,
    rawPath: caminho,
    pathParameters: achado.re.exec(caminho)?.groups ?? null,
    queryStringParameters: query ?? null,
    body: corpo ? JSON.stringify(corpo) : undefined,
    isBase64Encoded: false,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: `00000000-0000-4000-9e2e-00000000000${ids[papel]}`,
            email: `e2e.${papel}@example.com`,
            name: `E2E ${papel}`,
            "custom:empresa_id": EMPRESA,
            "cognito:groups": `[${papel}]`,
          },
          scopes: null,
        },
      },
    },
  };
  const funcao: FuncaoApi = achado.r.funcao;
  const r = await lambda.send(
    new InvokeCommand({ FunctionName: `driveguard-backend-${STAGE}-${funcao}`, Payload: Buffer.from(JSON.stringify(evento)) }),
  );
  const saida = JSON.parse(Buffer.from(r.Payload!).toString("utf8"));
  if (r.FunctionError) return { status: 500, corpo: saida };
  let dados: any = saida.body;
  try {
    dados = JSON.parse(saida.body);
  } catch {
    /* CSV ou vazio */
  }
  return { status: saida.statusCode, corpo: dados };
}

const chamar = alvo === "aws" ? viaLambda : viaHttp;

// ------------------------------------------------------------------- relato

const resultados: { nome: string; ok: boolean; detalhe: string }[] = [];

async function passo(nome: string, fn: () => Promise<string | void>) {
  try {
    const detalhe = (await fn()) ?? "";
    resultados.push({ nome, ok: true, detalhe });
    console.log(`  ok   ${nome}${detalhe ? `  (${detalhe})` : ""}`);
  } catch (e) {
    resultados.push({ nome, ok: false, detalhe: (e as Error).message });
    console.log(`  FALHA ${nome}: ${(e as Error).message}`);
  }
}

function esperar(r: Resp, status: number, oQue = "") {
  if (r.status !== status) throw new Error(`${oQue} esperado ${status}, veio ${r.status}: ${JSON.stringify(r.corpo).slice(0, 300)}`);
  return r.corpo;
}

const g = (caminho: string, query?: Record<string, string>, papel: Papel = "gestor") => chamar(papel, "GET", caminho, query);

// ---------------------------------------------------------------- roteiro

async function principal() {
  console.log(`\nE2E do Backend (${alvo})\n`);

  if (alvo === "aws") {
    await passo("API rejeita requisição sem token (401)", async () => {
      const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm").catch(() => ({}) as never);
      let api = process.env.API_URL;
      if (!api && SSMClient) {
        const p = await new SSMClient({}).send(new GetParameterCommand({ Name: `/driveguard-${STAGE}/backend/api_url` }));
        api = p.Parameter?.Value;
      }
      if (!api) return "API_URL não informada; pulado";
      const r = await fetch(`${api}/dashboard/kpis`);
      if (r.status !== 401) throw new Error(`veio ${r.status}`);
      return api;
    });
  }

  console.log("\nSessão e papéis");
  for (const papel of ["admin", "gestor", "operador"] as Papel[]) {
    await passo(`/me como ${papel}`, async () => {
      const me = esperar(await g("/me", undefined, papel), 200);
      if (me.papel !== papel || me.empresa.id !== EMPRESA) throw new Error(JSON.stringify(me));
      return me.empresa.nome;
    });
  }
  for (const [caminho, papel] of [["/dashboard/roi", "operador"], ["/relatorios", "operador"], ["/cadastros/motoristas", "operador"], ["/usuarios", "gestor"]] as const) {
    await passo(`${papel} barrado em ${caminho} (403)`, async () => void esperar(await g(caminho, undefined, papel), 403));
  }

  console.log("\nVisão gerencial e monitoramento");
  await passo("KPIs (30 dias, com período anterior)", async () => {
    const k = esperar(await g("/dashboard/kpis", { periodo: "30d" }), 200);
    if (k.aoVivo.motoristasMonitorados < 1 || k.periodo.fadigaMedia === null) throw new Error(JSON.stringify(k).slice(0, 200));
    return `${k.aoVivo.motoristasAtivos} dirigindo, fadiga ${k.periodo.fadigaMedia}, anterior ${k.periodo.fadigaMediaAnterior}`;
  });
  await passo("KPIs filtrados (Sudeste, caminhão, 90 dias)", async () => void esperar(await g("/dashboard/kpis", { periodo: "90d", regiao: "Sudeste", tipo_veiculo: "caminhao" }), 200));
  await passo("Alertas em tempo real", async () => {
    const t = esperar(await g("/dashboard/alertas-tempo-real"), 200);
    return `${t.motoristas.length} em risco, ${t.eventos.length} eventos`;
  });
  await passo("Tendência no turno", async () => {
    const t = esperar(await g("/dashboard/tendencia-turno"), 200);
    if (t.pontos.length !== 12) throw new Error("esperava 12 horas");
    return `pico ${t.resumo.pico?.hora}`;
  });
  await passo("Evolução da fadiga (90 dias)", async () => {
    const e = esperar(await g("/dashboard/evolucao-fadiga", { periodo: "90d" }), 200);
    const comDado = e.serie.filter((s: any) => s.fadiga !== null).length;
    if (comDado < 30) throw new Error(`só ${comDado} dias com dado`);
    return `${comDado} dias com dado, variação ${e.variacao}%`;
  });
  await passo("Rotas com incidência e PRF", async () => {
    const r = esperar(await g("/dashboard/rotas"), 200);
    if (!r.length) throw new Error("sem rotas");
    return `${r.length} rotas, PRF na 1ª: ${r[0].prf?.acidentesSono ?? "—"}`;
  });
  await passo("Heatmap padrão (7 dias)", async () => {
    const h = esperar(await g("/dashboard/heatmap"), 200);
    if (h.dias.length !== 7 || h.faixas.length !== 6) throw new Error("formato");
  });
  await passo("Heatmap com calendário (14 dias)", async () => {
    const hoje = new Date();
    const de = new Date(hoje.getTime() - 13 * 86400_000).toISOString().slice(0, 10);
    const h = esperar(await g("/dashboard/heatmap", { de, ate: hoje.toISOString().slice(0, 10) }), 200);
    if (h.dias.length !== 14) throw new Error(`${h.dias.length} dias`);
  });
  await passo("Fadiga × tempo de direção", async () => void esperar(await g("/dashboard/fadiga-tempo-direcao"), 200));
  for (const prf of ["resumo", "faixa-horaria", "causas", "mapa"]) {
    await passo(`PRF ${prf} (pesados e todos)`, async () => {
      const a = esperar(await g(`/dashboard/prf/${prf}`), 200);
      esperar(await g(`/dashboard/prf/${prf}`, { pesados: "false" }), 200);
      if (!a.carregada) throw new Error("base da PRF não carregada");
    });
  }
  await passo("ROI", async () => {
    const r = esperar(await g("/dashboard/roi"), 200);
    if (!r.disponivel) throw new Error(r.pendencias.join(" "));
    return `${r.reducaoAcidentesSonoPercentual}% menos acidentes por sono, ${r.cenarios.conservador.custoEvitado} R$/ano`;
  });
  await passo("Exportar CSV", async () => {
    const r = await g("/dashboard/exportar");
    if (r.status !== 200 || !String(r.corpo).includes("Código;Motorista")) throw new Error("CSV inválido");
  });
  await passo("Insights: pedir nova análise do período (7 dias) e ver o resultado", async () => {
    const pedido = esperar(await chamar("gestor", "POST", "/dashboard/insights/gerar", { periodo: "7d" }, {}), 202);
    for (let i = 0; i < 30; i++) {
      const ins = esperar(await g("/dashboard/insights", { periodo: "7d" }), 200);
      if (ins.periodo?.dias !== 7) throw new Error(`período errado: ${JSON.stringify(ins.periodo)}`);
      if (ins.execucaoId === pedido.execucaoId) return `${ins.recomendacoes.length} recomendações por ${ins.origem}`;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    throw new Error("a rodada não terminou em 90 s");
  });

  console.log("\nMotoristas e alertas");
  let motoristaId = "";
  await passo("Lista ao vivo", async () => {
    const l = esperar(await g("/motoristas/ao-vivo", undefined, "operador"), 200);
    motoristaId = (l.find((m: any) => m.ativo) ?? l[0]).motoristaId;
    return `${l.length} motoristas, ${l.filter((m: any) => m.ativo).length} ativos`;
  });
  for (const sub of ["", "/curva-turno", "/insights", "/alertas"]) {
    await passo(`Motorista${sub || " (detalhe)"}`, async () => void esperar(await g(`/motoristas/${motoristaId}${sub}`, undefined, "operador"), 200));
  }
  await passo("Ação rápida: solicitar pausa", async () => void esperar(await chamar("operador", "POST", `/motoristas/${motoristaId}/acoes`, undefined, { tipo: "pausa_obrigatoria", descricao: "E2E" }), 201));
  await passo("Ação rápida: registrar contato", async () => void esperar(await chamar("operador", "POST", `/motoristas/${motoristaId}/acoes`, undefined, { tipo: "contato_telefonico" }), 201));
  await passo("Registrar ocorrência", async () =>
    void esperar(await chamar("operador", "POST", `/motoristas/${motoristaId}/ocorrencias`, undefined, { descricao: "E2E: motorista relatou sonolência", relacionadoSonolencia: true }), 201));
  await passo("Validação em português (ação inválida → 400)", async () => {
    const r = await chamar("operador", "POST", `/motoristas/${motoristaId}/acoes`, undefined, { tipo: "xyz" });
    esperar(r, 400);
  });
  await passo("Alertas: listar e reconhecer", async () => {
    const l = esperar(await g("/alertas", { horas: "720", limite: "20" }, "operador"), 200);
    const aberto = l.find((a: any) => a.status === "aberto") ?? l[0];
    if (!aberto) return "sem alertas";
    esperar(await chamar("operador", "PATCH", `/alertas/${aberto.id}`, undefined, { status: "reconhecido" }), 200);
    return `${l.length} alertas`;
  });

  console.log("\nRelatórios");
  await passo("Resumo (30 dias e filtros)", async () => {
    const r = esperar(await g("/relatorios/resumo", { periodo: "30d" }), 200);
    esperar(await g("/relatorios/resumo", { periodo: "90d", risco: "alto", faixa_horaria: "madrugada", regiao: "Sul" }), 200);
    return `${r.kpis.eventos} alertas, economia ${r.kpis.economiaEstimada}`;
  });
  let relatorioId = "";
  for (const [tipo, formato] of [["executivo", "pdf"], ["operacional", "xlsx"], ["motoristas", "pdf"], ["frota", "pdf"], ["alertas", "csv"], ["executivo", "xlsx"]]) {
    await passo(`Gerar ${tipo} em ${formato}`, async () => {
      const r = esperar(await chamar("gestor", "POST", "/relatorios", undefined, { tipo, formato, filtros: { periodo: "30d" } }), 201);
      relatorioId = r.id;
      return `${r.tamanhoBytes} bytes`;
    });
  }
  await passo("Gerar com envio por e-mail (fallback sem SES)", async () =>
    void esperar(await chamar("gestor", "POST", "/relatorios", undefined, { tipo: "executivo", formato: "pdf", destinatarios: ["gestor@example.com"] }), 201));
  await passo("Histórico e download", async () => {
    const l = esperar(await g("/relatorios"), 200);
    const d = esperar(await g(`/relatorios/${relatorioId}/download`), 200);
    if (!d.url) throw new Error("sem url");
    return `${l.length} no histórico`;
  });
  await passo("Agendamento: criar, alterar e remover", async () => {
    const a = esperar(
      await chamar("gestor", "POST", "/relatorios/agendamentos", undefined, { tipo: "alertas", formato: "csv", frequencia: "semanal", horario: "08:00", diaSemana: 1, destinatarios: ["frota@example.com"] }),
      201,
    );
    esperar(
      await chamar("gestor", "PUT", `/relatorios/agendamentos/${a.id}`, undefined, { tipo: "executivo", formato: "pdf", frequencia: "mensal", horario: "07:00", diaMes: 1, destinatarios: ["frota@example.com"], ativo: false }),
      200,
    );
    esperar(await g("/relatorios/agendamentos"), 200);
    esperar(await chamar("gestor", "DELETE", `/relatorios/agendamentos/${a.id}`), 204);
  });

  console.log("\nCadastros");
  await passo("Empresa e UFs", async () => {
    const e = esperar(await g("/cadastros/empresa"), 200);
    esperar(await chamar("gestor", "PUT", "/cadastros/empresa", undefined, { frotaTotal: e.frotaTotal ?? 20 }), 200);
    esperar(await g("/cadastros/ufs"), 200);
  });
  let veiculoId = "";
  await passo("Veículo: criar e editar", async () => {
    const placa = `EEE${Math.floor(Math.random() * 10)}A${String(Math.floor(Math.random() * 90) + 10)}`;
    const v = esperar(await chamar("gestor", "POST", "/cadastros/veiculos", undefined, { placa, tipo: "caminhao", modelo: "E2E" }), 201);
    veiculoId = v.id;
    esperar(await chamar("gestor", "PUT", `/cadastros/veiculos/${v.id}`, undefined, { tipo: "caminhao", modelo: "E2E editado", ativo: true }), 200);
    return v.placa;
  });
  await passo("Câmera: cadastrar, instalar, histórico e retirar", async () => {
    const c = esperar(await chamar("gestor", "POST", "/cadastros/dispositivos", undefined, { deviceId: `dg-e2e-${sufixo.toLowerCase()}`, codigo: `E2E-${sufixo}` }), 201);
    esperar(await chamar("gestor", "POST", `/cadastros/dispositivos/${c.id}/vincular`, undefined, { veiculoId, motivo: "E2E" }), 200);
    const h = esperar(await g(`/cadastros/dispositivos/${c.id}/historico`), 200);
    esperar(await chamar("gestor", "POST", `/cadastros/dispositivos/${c.id}/desvincular`, undefined, { motivo: "E2E" }), 200);
    esperar(await chamar("gestor", "PUT", `/cadastros/dispositivos/${c.id}`, undefined, { codigo: `E2E-${sufixo}`, status: "inativo" }), 200);
    esperar(await chamar("gestor", "PUT", `/cadastros/veiculos/${veiculoId}`, undefined, { tipo: "caminhao", modelo: "E2E", ativo: false }), 200);
    esperar(await g("/cadastros/dispositivos"), 200);
    return `${h.length} vínculo(s)`;
  });
  await passo("Motorista: cadastrar e editar", async () => {
    const m = esperar(await chamar("gestor", "POST", "/cadastros/motoristas", undefined, { codigo: `E2E-${sufixo}`, nome: "Motorista E2E", idade: 40, regiaoUf: "SP" }), 201);
    esperar(await chamar("gestor", "PUT", `/cadastros/motoristas/${m.id}`, undefined, { nome: "Motorista E2E", status: "inativo" }), 200);
    esperar(await g("/cadastros/motoristas"), 200);
  });
  let rotaId = "";
  await passo("Rota: cadastrar e editar", async () => {
    const r = esperar(await chamar("gestor", "POST", "/cadastros/rotas", undefined, { nome: `E2E ${sufixo}`, origemCidade: "Santos", origemUf: "SP", destinoCidade: "Uberaba", destinoUf: "MG", brs: ["BR-050"] }), 201);
    rotaId = r.id;
    esperar(await chamar("gestor", "PUT", `/cadastros/rotas/${r.id}`, undefined, { nome: `E2E ${sufixo}`, origemCidade: "Santos", origemUf: "SP", destinoCidade: "Uberaba", destinoUf: "MG", brs: ["50"], ativo: false }), 200);
    esperar(await g("/cadastros/rotas"), 200);
  });
  await passo("Viagem: cadastrar e cancelar", async () => {
    const veiculos = esperar(await g("/cadastros/veiculos"), 200);
    const ativo = veiculos.find((v: any) => v.ativo);
    const corpo = { rotaId, veiculoId: ativo.id, partidaPrevista: new Date(Date.now() + 86400_000).toISOString(), chegadaPrevista: new Date(Date.now() + 2 * 86400_000).toISOString(), valorViagem: 1000 };
    const v = esperar(await chamar("gestor", "POST", "/cadastros/viagens", undefined, corpo), 201);
    esperar(await chamar("gestor", "PUT", `/cadastros/viagens/${v.id}`, undefined, { ...corpo, status: "cancelada" }), 200);
    esperar(await g("/cadastros/viagens"), 200);
  });
  await passo("Parâmetro do ROI: alterar e restaurar", async () => {
    esperar(await g("/cadastros/parametros-roi"), 200);
    esperar(await chamar("gestor", "PUT", "/cadastros/parametros-roi/eficacia_alerta", undefined, { valor: 0.4, fonte: "E2E" }), 200);
    const r = esperar(await chamar("gestor", "DELETE", "/cadastros/parametros-roi/eficacia_alerta"), 200);
    if (r.valor !== 0.5) throw new Error(`restaurado para ${r.valor}`);
  });

  console.log("\nUsuários");
  await passo("Admin: listar, criar, trocar papel, nova senha e remover", async () => {
    const l = esperar(await g("/usuarios", undefined, "admin"), 200);
    const c = esperar(await chamar("admin", "POST", "/usuarios", undefined, { email: `e2e.${sufixo.toLowerCase()}@example.com`, nome: "Usuário E2E", papel: "operador" }), 201);
    const u = encodeURIComponent(c.usuario.username);
    const p = esperar(await chamar("admin", "PATCH", `/usuarios/${u}`, undefined, { papel: "gestor" }), 200);
    if (p.papel !== "gestor") throw new Error("papel não mudou");
    esperar(await chamar("admin", "POST", `/usuarios/${u}/redefinir-senha`, undefined, {}), 200);
    esperar(await chamar("admin", "DELETE", `/usuarios/${u}`), 204);
    return `${l.length} usuários antes`;
  });

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} passos ok${falhas.length ? `; FALHAS: ${falhas.map((f) => f.nome).join(" | ")}` : ""}\n`);
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
