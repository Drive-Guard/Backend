/**
 * Arquivos trocados pelo S3 (bucket de artefatos).
 *
 * As Lambdas de dentro da VPC (banco) e de fora (internet: IA, e-mail) não se
 * chamam: uma grava um arquivo, a regra do EventBridge entrega o evento de
 * "Object Created" à outra. Os prefixos:
 *
 *   insights/contextos/<empresa>/<execucao>.json   API/agendado -> insightsIa
 *   insights/respostas/<empresa>/<execucao>.json   insightsIa   -> insightsGravar
 *   relatorios/arquivos/<empresa>/<id>.<ext>       arquivo final do relatório
 *   relatorios/envios/<id>.json                    API/agendado -> relatorioEnviar
 *   relatorios/resultados/<id>.json                relatorioEnviar -> relatorioStatus
 *
 * Em desenvolvimento (ARQUIVOS_DIR definido) tudo vai para uma pasta local e o
 * servidor de dev processa a cadeia na hora.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";

const BUCKET = () => process.env.REPORTS_BUCKET ?? "";
const DIR_LOCAL = () => process.env.ARQUIVOS_DIR;

let s3: S3Client | null = null;
async function cliente(): Promise<S3Client> {
  if (!s3) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    s3 = new S3Client({});
  }
  return s3;
}

/** Ganchos do servidor de desenvolvimento: simulam as regras do EventBridge. */
type Gancho = (chave: string) => Promise<void>;
const ganchos: Gancho[] = [];
export function aoGravarLocal(g: Gancho): void {
  ganchos.push(g);
}

export async function gravar(chave: string, conteudo: Buffer | string, tipo: string): Promise<void> {
  const dir = DIR_LOCAL();
  if (dir) {
    const caminho = join(dir, chave);
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo);
    for (const g of ganchos) await g(chave);
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await cliente()).send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: chave,
      Body: conteudo,
      ContentType: tipo,
      ServerSideEncryption: "AES256",
    }),
  );
}

export const gravarJson = (chave: string, dados: unknown) =>
  gravar(chave, JSON.stringify(dados), "application/json");

export async function ler(chave: string, bucket?: string): Promise<Buffer> {
  const dir = DIR_LOCAL();
  if (dir) return readFileSync(join(dir, chave));
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const r = await (await cliente()).send(new GetObjectCommand({ Bucket: bucket ?? BUCKET(), Key: chave }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export async function lerJson<T>(chave: string, bucket?: string): Promise<T> {
  return JSON.parse((await ler(chave, bucket)).toString("utf8")) as T;
}

export async function apagar(chave: string): Promise<void> {
  const dir = DIR_LOCAL();
  if (dir) {
    rmSync(join(dir, chave), { force: true });
    return;
  }
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await (await cliente()).send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: chave }));
}

export function existeLocal(chave: string): boolean {
  const dir = DIR_LOCAL();
  return !!dir && existsSync(join(dir, chave));
}

/**
 * Link temporário para baixar o arquivo.
 *
 * Assinado com a credencial da Lambda: vale no máximo o que a credencial
 * vale (algumas horas). Por isso o e-mail de relatório aponta para a
 * dashboard, que gera um link novo a cada clique.
 */
export async function linkTemporario(chave: string, nomeArquivo: string, segundos = 900): Promise<string> {
  const dir = DIR_LOCAL();
  if (dir) return `${process.env.DEV_API_URL ?? "http://localhost:3001"}/arquivos/${chave}`;
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(
    await cliente(),
    new GetObjectCommand({
      Bucket: BUCKET(),
      Key: chave,
      ResponseContentDisposition: `attachment; filename="${nomeArquivo}"`,
    }),
    { expiresIn: segundos },
  );
}

/** Bucket e chave de um evento "Object Created" do S3 entregue pelo EventBridge. */
export function objetoDoEvento(evento: { detail?: { bucket?: { name?: string }; object?: { key?: string } } }) {
  const bucket = evento.detail?.bucket?.name;
  const chave = evento.detail?.object?.key;
  if (!bucket || !chave) throw new Error("Evento sem bucket/objeto do S3");
  return { bucket, chave: decodeURIComponent(chave.replace(/\+/g, " ")) };
}
