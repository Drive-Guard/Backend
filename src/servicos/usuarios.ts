/**
 * Usuários da dashboard (Amazon Cognito). Roda FORA da VPC: fala só com a API
 * do Cognito, não com o banco.
 *
 * Só administradores chegam aqui, e só enxergam os usuários da própria empresa
 * (atributo custom:empresa_id). O usuário novo recebe uma senha temporária,
 * mostrada uma única vez ao administrador; no primeiro login a dashboard pede
 * a troca.
 *
 * Com USUARIOS_DEV=1 (servidor de desenvolvimento) os usuários ficam em memória.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Papel, Usuario } from "../lib/auth";
import { PAPEIS } from "../lib/auth";
import { conflito, invalido, naoEncontrado } from "../lib/http";

export interface UsuarioDashboard {
  username: string;
  email: string;
  nome: string;
  papel: Papel | null;
  ativo: boolean;
  status: string;
  criadoEm: string | null;
}

export const schemaNovoUsuario = z.object({
  email: z.string().trim().toLowerCase().email("e-mail inválido"),
  nome: z.string().trim().min(2).max(120),
  papel: z.enum(PAPEIS),
});
export const schemaAtualizacaoUsuario = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  papel: z.enum(PAPEIS).optional(),
  ativo: z.boolean().optional(),
});

/** Senha temporária que atende a política do pool (maiúscula, minúscula, número). */
export function senhaTemporaria(): string {
  const base = randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return `Dg${base.slice(0, 8)}7a`;
}

interface Provedor {
  listar(empresaId: string): Promise<UsuarioDashboard[]>;
  criar(empresaId: string, d: z.infer<typeof schemaNovoUsuario>, senha: string): Promise<UsuarioDashboard>;
  obter(username: string): Promise<{ usuario: UsuarioDashboard; empresaId: string } | null>;
  definirPapel(username: string, papel: Papel): Promise<void>;
  definirNome(username: string, nome: string): Promise<void>;
  ativar(username: string, ativo: boolean): Promise<void>;
  remover(username: string): Promise<void>;
  redefinirSenha(username: string, senha: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cognito
// ---------------------------------------------------------------------------

function provedorCognito(): Provedor {
  const pool = process.env.USER_POOL_ID ?? "";
  let cliente: import("@aws-sdk/client-cognito-identity-provider").CognitoIdentityProviderClient | null = null;
  const sdk = () => import("@aws-sdk/client-cognito-identity-provider");
  const c = async () => {
    if (!cliente) cliente = new (await sdk()).CognitoIdentityProviderClient({});
    return cliente;
  };

  type Bruto = { Username?: string; Attributes?: { Name?: string; Value?: string }[]; UserAttributes?: { Name?: string; Value?: string }[]; Enabled?: boolean; UserStatus?: string; UserCreateDate?: Date };
  const atributo = (u: Bruto, nome: string) => (u.Attributes ?? u.UserAttributes ?? []).find((a) => a.Name === nome)?.Value;

  async function papelDe(username: string): Promise<Papel | null> {
    const { AdminListGroupsForUserCommand } = await sdk();
    const r = await (await c()).send(new AdminListGroupsForUserCommand({ UserPoolId: pool, Username: username }));
    const grupos = (r.Groups ?? []).map((g) => g.GroupName);
    return PAPEIS.find((p) => grupos.includes(p)) ?? null;
  }

  const converter = async (u: Bruto): Promise<UsuarioDashboard> => ({
    username: u.Username!,
    email: atributo(u, "email") ?? "",
    nome: atributo(u, "name") ?? atributo(u, "email") ?? u.Username!,
    papel: await papelDe(u.Username!),
    ativo: u.Enabled !== false,
    status: u.UserStatus ?? "",
    criadoEm: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
  });

  return {
    async listar(empresaId) {
      const { ListUsersCommand } = await sdk();
      const todos: Bruto[] = [];
      let token: string | undefined;
      do {
        const r = await (await c()).send(new ListUsersCommand({ UserPoolId: pool, PaginationToken: token, Limit: 60 }));
        todos.push(...((r.Users ?? []) as Bruto[]));
        token = r.PaginationToken;
      } while (token);
      // O filtro do ListUsers não aceita atributo customizado: filtra aqui.
      return Promise.all(todos.filter((u) => atributo(u, "custom:empresa_id") === empresaId).map(converter));
    },
    async criar(empresaId, d, senha) {
      const { AdminCreateUserCommand, AdminAddUserToGroupCommand } = await sdk();
      try {
        const r = await (await c()).send(
          new AdminCreateUserCommand({
            UserPoolId: pool,
            Username: d.email,
            TemporaryPassword: senha,
            MessageAction: "SUPPRESS",
            UserAttributes: [
              { Name: "email", Value: d.email },
              { Name: "email_verified", Value: "true" },
              { Name: "name", Value: d.nome },
              { Name: "custom:empresa_id", Value: empresaId },
            ],
          }),
        );
        await (await c()).send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: r.User!.Username!, GroupName: d.papel }));
        return { ...(await converter(r.User as Bruto)), papel: d.papel };
      } catch (e) {
        if ((e as Error).name === "UsernameExistsException") throw conflito("Já existe um usuário com este e-mail.");
        if ((e as Error).name === "InvalidPasswordException") throw invalido("Senha temporária fora da política do pool.");
        throw e;
      }
    },
    async obter(username) {
      const { AdminGetUserCommand } = await sdk();
      try {
        const r = await (await c()).send(new AdminGetUserCommand({ UserPoolId: pool, Username: username }));
        const bruto: Bruto = { Username: r.Username, UserAttributes: r.UserAttributes, Enabled: r.Enabled, UserStatus: r.UserStatus, UserCreateDate: r.UserCreateDate };
        return { usuario: await converter(bruto), empresaId: atributo(bruto, "custom:empresa_id") ?? "" };
      } catch (e) {
        if ((e as Error).name === "UserNotFoundException") return null;
        throw e;
      }
    },
    async definirPapel(username, papel) {
      const { AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand } = await sdk();
      for (const p of PAPEIS.filter((x) => x !== papel)) {
        await (await c()).send(new AdminRemoveUserFromGroupCommand({ UserPoolId: pool, Username: username, GroupName: p })).catch(() => undefined);
      }
      await (await c()).send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: username, GroupName: papel }));
    },
    async definirNome(username, nome) {
      const { AdminUpdateUserAttributesCommand } = await sdk();
      await (await c()).send(new AdminUpdateUserAttributesCommand({ UserPoolId: pool, Username: username, UserAttributes: [{ Name: "name", Value: nome }] }));
    },
    async ativar(username, ativo) {
      const { AdminEnableUserCommand, AdminDisableUserCommand } = await sdk();
      await (await c()).send(ativo ? new AdminEnableUserCommand({ UserPoolId: pool, Username: username }) : new AdminDisableUserCommand({ UserPoolId: pool, Username: username }));
    },
    async remover(username) {
      const { AdminDeleteUserCommand } = await sdk();
      await (await c()).send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: username }));
    },
    async redefinirSenha(username, senha) {
      const { AdminSetUserPasswordCommand } = await sdk();
      await (await c()).send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username: username, Password: senha, Permanent: false }));
    },
  };
}

// ---------------------------------------------------------------------------
// Em memória (desenvolvimento local)
// ---------------------------------------------------------------------------

function provedorMemoria(): Provedor {
  const dados = new Map<string, { usuario: UsuarioDashboard; empresaId: string }>();
  return {
    async listar(empresaId) {
      return [...dados.values()].filter((d) => d.empresaId === empresaId).map((d) => d.usuario);
    },
    async criar(empresaId, d) {
      if ([...dados.values()].some((x) => x.usuario.email === d.email)) throw conflito("Já existe um usuário com este e-mail.");
      const usuario: UsuarioDashboard = { username: randomUUID(), email: d.email, nome: d.nome, papel: d.papel, ativo: true, status: "FORCE_CHANGE_PASSWORD", criadoEm: new Date().toISOString() };
      dados.set(usuario.username, { usuario, empresaId });
      return usuario;
    },
    async obter(username) {
      return dados.get(username) ?? null;
    },
    async definirPapel(username, papel) {
      dados.get(username)!.usuario.papel = papel;
    },
    async definirNome(username, nome) {
      dados.get(username)!.usuario.nome = nome;
    },
    async ativar(username, ativo) {
      dados.get(username)!.usuario.ativo = ativo;
    },
    async remover(username) {
      dados.delete(username);
    },
    async redefinirSenha(username) {
      dados.get(username)!.usuario.status = "FORCE_CHANGE_PASSWORD";
    },
  };
}

let provedor: Provedor | null = null;
const p = () => (provedor ??= process.env.USUARIOS_DEV === "1" ? provedorMemoria() : provedorCognito());

async function daEmpresa(admin: Usuario, username: string) {
  const r = await p().obter(username);
  if (!r || r.empresaId !== admin.empresaId) throw naoEncontrado("Usuário");
  return r.usuario;
}

export const listar = (admin: Usuario) => p().listar(admin.empresaId);

export async function criar(admin: Usuario, d: z.infer<typeof schemaNovoUsuario>) {
  const senha = senhaTemporaria();
  const usuario = await p().criar(admin.empresaId, d, senha);
  return { usuario, senhaTemporaria: senha };
}

export async function atualizar(admin: Usuario, username: string, d: z.infer<typeof schemaAtualizacaoUsuario>) {
  const alvo = await daEmpresa(admin, username);
  if (alvo.email === admin.email && (d.ativo === false || (d.papel && d.papel !== "admin"))) {
    throw invalido("Você não pode desativar nem rebaixar o próprio usuário.");
  }
  if (d.nome) await p().definirNome(username, d.nome);
  if (d.papel) await p().definirPapel(username, d.papel);
  if (d.ativo !== undefined) await p().ativar(username, d.ativo);
  return daEmpresa(admin, username);
}

export async function remover(admin: Usuario, username: string) {
  const alvo = await daEmpresa(admin, username);
  if (alvo.email === admin.email) throw invalido("Você não pode remover o próprio usuário.");
  await p().remover(username);
}

export async function redefinirSenha(admin: Usuario, username: string) {
  await daEmpresa(admin, username);
  const senha = senhaTemporaria();
  await p().redefinirSenha(username, senha);
  return { senhaTemporaria: senha };
}
