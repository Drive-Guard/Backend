/**
 * DriveGuard Backend — configuração do osls (fork mantido do Serverless
 * Framework v3, que não exige login nem licença).
 *
 * O Terraform do repositório Infra já criou a API HTTP, o autorizador JWT do
 * Cognito, a VPC e o banco, e publicou tudo no SSM em /driveguard-<stage>/backend/.
 * Este deploy só cria as Lambdas e pendura as rotas na API existente.
 *
 * No AWS Academy Learner Lab não dá para criar role: todas as funções usam a
 * LabRole (provider.iam.role).
 *
 * As rotas vêm de src/rotas.ts: cada rota vira um evento httpApi da Lambda do
 * seu domínio, todas atrás do autorizador.
 */

import type { AWS } from "@serverless/typescript";
import { rotas, type FuncaoApi } from "./src/rotas";

const ssm = (nome: string) => `\${ssm:/driveguard-\${sls:stage}/backend/${nome}}`;

const vpc = {
  securityGroupIds: [ssm("security_group_id")],
  subnetIds: ssm("subnet_ids") as unknown as string[],
};

const banco = {
  DB_HOST: ssm("db_host"),
  DB_PORT: ssm("db_port"),
  DB_NAME: ssm("db_name"),
  DB_USER: ssm("db_user"),
  DB_PASSWORD: ssm("db_password"),
};

const pacote = (pasta: string) => ({ patterns: ["!**", `dist/${pasta}/**`] });

function eventosHttp(funcao: FuncaoApi) {
  return rotas
    .filter((r) => r.funcao === funcao)
    .map((r) => ({ httpApi: { method: r.metodo, path: r.caminho, authorizer: { id: ssm("authorizer_id") } } }));
}

/** Regra do EventBridge para "Object Created" no bucket de artefatos, filtrada por prefixo. */
function aoCriarArquivo(prefixo: string) {
  return {
    eventBridge: {
      pattern: {
        source: ["aws.s3"],
        "detail-type": ["Object Created"],
        detail: { bucket: { name: [ssm("reports_bucket")] }, object: { key: [{ prefix: prefixo }] } },
      },
    },
  };
}

function apiNaVpc(funcao: FuncaoApi, descricao: string, memoria = 512) {
  return {
    handler: `dist/${funcao}/index.handler`,
    description: descricao,
    memorySize: memoria,
    timeout: 29,
    vpc,
    environment: banco,
    package: pacote(funcao),
    events: eventosHttp(funcao),
  };
}

function worker(nome: string, descricao: string, extra: Record<string, unknown>) {
  return {
    handler: `dist/workers/index.${nome}`,
    description: descricao,
    package: pacote("workers"),
    ...extra,
  };
}

const config: AWS = {
  service: "driveguard-backend",
  configValidationMode: "warn",
  provider: {
    name: "aws",
    runtime: "nodejs22.x",
    architecture: "x86_64",
    region: "us-east-1",
    stage: "dev",
    memorySize: 512,
    timeout: 29,
    logRetentionInDays: 7,
    versionFunctions: false,
    iam: { role: ssm("lambda_role_arn") },
    deploymentBucket: { name: ssm("deployment_bucket"), serverSideEncryption: "AES256" },
    httpApi: { id: ssm("http_api_id") },
    environment: {
      NODE_OPTIONS: "--enable-source-maps",
      REPORTS_BUCKET: ssm("reports_bucket"),
      SITE_URL: ssm("site_url"),
    },
  },
  package: { individually: true },
  functions: {
    // ----------------------------------------------------------- API (VPC)
    dashboard: apiNaVpc("dashboard", "Visão geral, base da PRF, insights e ROI"),
    motoristas: apiNaVpc("motoristas", "Motoristas: lista ao vivo, detalhe, curva do turno e ações"),
    alertas: apiNaVpc("alertas", "Alertas da frota"),
    relatorios: apiNaVpc("relatorios", "Relatórios (PDF, Excel, CSV) e agendamentos", 1024),
    cadastros: apiNaVpc("cadastros", "Cadastros: motoristas, veículos, câmeras, rotas, viagens, ROI"),

    // -------------------------------------------------- API (fora da VPC)
    usuarios: {
      handler: "dist/usuarios/index.handler",
      description: "Usuários da dashboard no Cognito",
      memorySize: 256,
      timeout: 29,
      environment: { USER_POOL_ID: ssm("user_pool_id") },
      package: pacote("usuarios"),
      events: eventosHttp("usuarios"),
    },

    // ------------------------------------------------------------ workers
    insightsContexto: worker("insightsContexto", "Monta o contexto dos insights (a cada hora)", {
      vpc,
      environment: banco,
      timeout: 120,
      events: [{ schedule: "rate(1 hour)" }],
    }),
    insightsIa: worker("insightsIa", "Gera os insights com IA (Gemini) ou regras", {
      // Até dois modelos com 45 s cada (ver IA_MODELO em servicos/insights/ia.ts).
      timeout: 120,
      environment: { IA_API_KEY: ssm("ia_api_key"), IA_MODELO: ssm("ia_modelo") },
      events: [aoCriarArquivo("insights/contextos/")],
    }),
    insightsGravar: worker("insightsGravar", "Grava os insights no banco", {
      vpc,
      environment: banco,
      timeout: 30,
      events: [aoCriarArquivo("insights/respostas/")],
    }),
    agendamentos: worker("agendamentos", "Gera os relatórios agendados vencidos", {
      vpc,
      environment: banco,
      timeout: 300,
      memorySize: 1024,
      events: [{ schedule: "rate(15 minutes)" }],
    }),
    relatorioEnviar: worker("relatorioEnviar", "Envia o relatório por e-mail (Gmail/SMTP ou SES) ou registra o fallback", {
      timeout: 30,
      environment: { EMAIL_REMETENTE: ssm("email_remetente"), SMTP_USUARIO: ssm("smtp_usuario"), SMTP_SENHA: ssm("smtp_senha") },
      events: [aoCriarArquivo("relatorios/envios/")],
    }),
    relatorioStatus: worker("relatorioStatus", "Grava no banco o resultado do envio", {
      vpc,
      environment: banco,
      timeout: 15,
      events: [aoCriarArquivo("relatorios/resultados/")],
    }),
  },
};

module.exports = config;
