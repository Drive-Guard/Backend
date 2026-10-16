/**
 * Envio do relatório por e-mail (Amazon SES). Roda FORA da VPC.
 *
 * O e-mail leva o link da dashboard (que gera um link novo a cada clique) e
 * um link direto para o arquivo, válido enquanto durar a credencial da
 * Lambda. Sem remetente verificado, ou com o SES bloqueado (caso do AWS
 * Academy Learner Lab), o envio é registrado como falho com o motivo e o
 * relatório segue disponível na dashboard: é o fallback por link.
 */

import { linkTemporario } from "../../lib/arquivos";
import type { PedidoEnvio, ResultadoEnvio } from "./index";

export async function enviarEmail(p: PedidoEnvio): Promise<ResultadoEnvio> {
  const remetente = process.env.EMAIL_REMETENTE ?? "";
  if (!remetente || remetente === "nao-configurado") {
    return { relatorioId: p.relatorioId, status: "falhou", erro: "Envio por e-mail não configurado: o relatório está disponível na dashboard.", enviadoEm: null };
  }

  try {
    const link = await linkTemporario(p.chave, p.nomeArquivo, 12 * 3600);
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const ses = new SESv2Client({});
    const texto =
      `${p.titulo}\n${p.periodo}\n\n` +
      `Abra na dashboard: ${p.linkDashboard}\n` +
      `Download direto (link temporário): ${link}\n\n` +
      `DriveGuard - monitoramento de fadiga`;
    const html =
      `<p><strong>${escapar(p.titulo)}</strong><br>${escapar(p.periodo)}</p>` +
      `<p><a href="${escapar(p.linkDashboard)}">Abrir na dashboard</a> · <a href="${escapar(link)}">baixar o arquivo</a> (link temporário)</p>` +
      `<p style="color:#6b7280">DriveGuard · monitoramento de fadiga</p>`;
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: remetente,
        Destination: { ToAddresses: p.destinatarios },
        Content: { Simple: { Subject: { Data: p.assunto, Charset: "UTF-8" }, Body: { Text: { Data: texto, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
      }),
    );
    return { relatorioId: p.relatorioId, status: "enviado", erro: null, enviadoEm: new Date().toISOString() };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const motivo = err.name === "AccessDeniedException" ? "SES indisponível nesta conta (acesso negado)" : `${err.name ?? "Erro"}: ${err.message ?? ""}`;
    return { relatorioId: p.relatorioId, status: "falhou", erro: `${motivo}. O relatório está disponível na dashboard.`.slice(0, 900), enviadoEm: null };
  }
}

const escapar = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
