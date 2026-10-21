/** Envio do relatório por e-mail: Gmail (SMTP) no Learner Lab, SES fora dele, fallback por link. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { enviarEmail } from "../src/servicos/relatorios/envio";

// O envio importa o nodemailer só na hora de mandar: o mock vale para ele.
const enviados: Record<string, unknown>[] = [];
let falhaSmtp: Error | null = null;

vi.mock("nodemailer", () => ({
  createTransport: (config: Record<string, unknown>) => ({
    sendMail: async (msg: Record<string, unknown>) => {
      if (falhaSmtp) throw falhaSmtp;
      enviados.push({ config, msg });
      return { messageId: "teste" };
    },
  }),
}));

const pedido = {
  relatorioId: "00000000-0000-4000-8000-0000000000aa",
  chave: "relatorios/arquivos/teste.pdf",
  nomeArquivo: "teste.pdf",
  destinatarios: ["gestor@empresa.com"],
  assunto: "Relatório executivo",
  titulo: "Relatório executivo",
  periodo: "Últimos 30 dias",
  linkDashboard: "http://localhost:5173/?aba=relatorios",
} as Parameters<typeof enviarEmail>[0];

afterEach(() => {
  enviados.length = 0;
  falhaSmtp = null;
  for (const v of ["SMTP_USUARIO", "SMTP_SENHA", "EMAIL_REMETENTE"]) delete process.env[v];
});

describe("envio por e-mail", () => {
  it("sem Gmail nem SES: falha com o motivo, relatório na dashboard", async () => {
    process.env.SMTP_USUARIO = "nao-configurado";
    const r = await enviarEmail(pedido);
    expect(r).toMatchObject({ status: "falhou" });
    expect(r.erro).toMatch(/Learner Lab bloqueia o SES.*dashboard/);
  });

  it("Gmail com senha de app: envia pelo SMTP com o link do arquivo", async () => {
    process.env.SMTP_USUARIO = "central@gmail.com";
    process.env.SMTP_SENHA = "abcd efgh ijkl mnop";
    const r = await enviarEmail(pedido);
    expect(r.status).toBe("enviado");
    const { config, msg } = enviados[0] as { config: { host: string; auth: { pass: string } }; msg: { from: string; to: string[]; html: string } };
    expect(config.host).toBe("smtp.gmail.com");
    expect(config.auth.pass).toBe("abcdefghijklmnop"); // o Google mostra a senha com espaços
    expect(msg.from).toBe('"DriveGuard" <central@gmail.com>');
    expect(msg.to).toEqual(["gestor@empresa.com"]);
    expect(msg.html).toContain("baixar o arquivo");
  });

  it("senha de app errada: motivo claro", async () => {
    process.env.SMTP_USUARIO = "central@gmail.com";
    process.env.SMTP_SENHA = "errada";
    falhaSmtp = Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
    const r = await enviarEmail(pedido);
    expect(r.status).toBe("falhou");
    expect(r.erro).toMatch(/Gmail recusou o login/);
  });
});
