/**
 * Envio do relatório por e-mail. Roda FORA da VPC.
 *
 * Dois caminhos, nesta ordem:
 *   1. SMTP (Gmail com senha de app): o caminho no AWS Academy Learner Lab,
 *      que bloqueia o SES. Configurado por email_smtp_usuario e
 *      email_smtp_senha no segredos.auto.tfvars;
 *   2. Amazon SES, com remetente verificado (email_remetente), numa conta
 *      que tenha SES.
 * Sem nenhum dos dois, ou se o envio falhar, fica registrado como falho com
 * o motivo e o relatório segue disponível na dashboard (fallback por link).
 *
 * O e-mail leva o link da dashboard (que gera um link novo a cada clique) e
 * um link direto para o arquivo, válido por 12 h.
 */

import { linkTemporario } from "../../lib/arquivos";
import type { PedidoEnvio, ResultadoEnvio } from "./index";

const configurado = (v: string | undefined) => !!v && v !== "nao-configurado";

export async function enviarEmail(p: PedidoEnvio): Promise<ResultadoEnvio> {
  const smtpUsuario = process.env.SMTP_USUARIO;
  const smtpSenha = process.env.SMTP_SENHA;
  const remetenteSes = process.env.EMAIL_REMETENTE;
  if (!(configurado(smtpUsuario) && configurado(smtpSenha)) && !configurado(remetenteSes)) {
    return falha(p, "Envio por e-mail não configurado (o Learner Lab bloqueia o SES; configure o Gmail com senha de app)");
  }

  try {
    const link = await linkTemporario(p.chave, p.nomeArquivo, 12 * 3600);
    const mensagem = montar(p, link);
    if (configurado(smtpUsuario) && configurado(smtpSenha)) {
      const { createTransport } = await import("nodemailer");
      const transporte = createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORTA || 465),
        secure: true,
        auth: { user: smtpUsuario, pass: smtpSenha!.replace(/\s+/g, "") },
      });
      await transporte.sendMail({
        from: `"DriveGuard" <${smtpUsuario}>`,
        to: p.destinatarios,
        subject: p.assunto,
        text: mensagem.texto,
        html: mensagem.html,
      });
    } else {
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      await new SESv2Client({}).send(
        new SendEmailCommand({
          FromEmailAddress: remetenteSes,
          Destination: { ToAddresses: p.destinatarios },
          Content: {
            Simple: {
              Subject: { Data: p.assunto, Charset: "UTF-8" },
              Body: { Text: { Data: mensagem.texto, Charset: "UTF-8" }, Html: { Data: mensagem.html, Charset: "UTF-8" } },
            },
          },
        }),
      );
    }
    return { relatorioId: p.relatorioId, status: "enviado", erro: null, enviadoEm: new Date().toISOString() };
  } catch (e) {
    return falha(p, motivoDoErro(e));
  }
}

function falha(p: PedidoEnvio, motivo: string): ResultadoEnvio {
  return { relatorioId: p.relatorioId, status: "falhou", erro: `${motivo}. O relatório está disponível na dashboard.`.slice(0, 900), enviadoEm: null };
}

function motivoDoErro(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: string; responseCode?: number };
  if (err.code === "EAUTH" || err.responseCode === 535) return "O Gmail recusou o login: confira o e-mail e a senha de app";
  if (err.code === "EENVELOPE") return "Endereço de destino recusado pelo servidor de e-mail";
  if (err.name === "AccessDeniedException") return "SES indisponível nesta conta (acesso negado)";
  return `${err.name ?? err.code ?? "Erro"}: ${err.message ?? ""}`;
}

function montar(p: PedidoEnvio, link: string) {
  const texto =
    `${p.titulo}\n${p.periodo}\n\n` +
    `Abra na dashboard: ${p.linkDashboard}\n` +
    `Download direto (link válido por 12 h): ${link}\n\n` +
    `DriveGuard - monitoramento de fadiga`;
  const html =
    `<p><strong>${escapar(p.titulo)}</strong><br>${escapar(p.periodo)}</p>` +
    `<p><a href="${escapar(p.linkDashboard)}">Abrir na dashboard</a> · <a href="${escapar(link)}">baixar o arquivo</a> (link válido por 12 h)</p>` +
    `<p style="color:#6b7280">DriveGuard · monitoramento de fadiga</p>`;
  return { texto, html };
}

const escapar = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
