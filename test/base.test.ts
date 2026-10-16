import { describe, expect, it } from "vitest";
import { exigirPapel, parsePapeis, usuarioDasClaims } from "../src/lib/auth";
import { periodoDe } from "../src/lib/filtros";
import { diaLocal, instanteLocal, partesLocais } from "../src/lib/tempo";
import { chaveDaRota, rotas } from "../src/rotas";
import { proximaExecucao } from "../src/servicos/relatorios/agendamentos";
import { textoPdf } from "../src/servicos/relatorios/pdf";
import { normalizarBr, normalizarPlaca } from "../src/servicos/cadastros";
import { EMPRESA_DEMO, usuario } from "./ajuda";

describe("autenticação", () => {
  it("lê os grupos do Cognito no formato texto do API Gateway", () => {
    expect(parsePapeis("[admin gestor]")).toEqual(["admin", "gestor"]);
    expect(parsePapeis("[operador]")).toEqual(["operador"]);
    expect(parsePapeis(["gestor"])).toEqual(["gestor"]);
    expect(parsePapeis("[outro]")).toEqual([]);
  });

  it("recusa token sem empresa ou sem papel", () => {
    const base = { sub: "x", email: "a@b.c", "custom:empresa_id": EMPRESA_DEMO, "cognito:groups": "[gestor]" };
    expect(usuarioDasClaims(base).papel).toBe("gestor");
    expect(() => usuarioDasClaims({ ...base, "custom:empresa_id": "" })).toThrow(/empresa/);
    expect(() => usuarioDasClaims({ ...base, "cognito:groups": "" })).toThrow(/papel/);
  });

  it("o papel mais alto vale", () => {
    expect(usuarioDasClaims({ sub: "x", "custom:empresa_id": EMPRESA_DEMO, "cognito:groups": "[operador admin]" }).papel).toBe("admin");
    expect(() => exigirPapel(usuario("operador"), ["admin", "gestor"])).toThrow();
    expect(() => exigirPapel(usuario("gestor"), ["admin", "gestor"])).not.toThrow();
  });
});

describe("rotas", () => {
  it("não repetem método + caminho", () => {
    const chaves = rotas.map(chaveDaRota);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("toda rota tem ação implementada na Lambda do domínio", async () => {
    // Importar a função já valida: o roteador lança se faltar ação.
    const modulos = await Promise.all([
      import("../src/funcoes/dashboard"),
      import("../src/funcoes/motoristas"),
      import("../src/funcoes/alertas"),
      import("../src/funcoes/relatorios"),
      import("../src/funcoes/cadastros"),
      import("../src/funcoes/usuarios"),
    ]);
    for (const m of modulos) expect(typeof m.handler).toBe("function");
  });

  it("usuários são só de admin; ROI e relatórios só de gestão", () => {
    for (const r of rotas.filter((x) => x.funcao === "usuarios")) expect(r.papeis).toEqual(["admin"]);
    for (const r of rotas.filter((x) => x.funcao === "relatorios" || x.caminho === "/dashboard/roi")) expect(r.papeis).not.toContain("operador");
  });
});

describe("tempo e períodos", () => {
  it("converte horário de Brasília em UTC", () => {
    expect(instanteLocal("2026-10-16", "08:00").toISOString()).toBe("2026-10-16T11:00:00.000Z");
    expect(partesLocais(new Date("2026-10-16T02:30:00Z")).hora).toBe(23);
  });

  it("período anterior tem o mesmo tamanho e vem logo antes", () => {
    const p = periodoDe({ de: "2026-10-01", ate: "2026-10-10" });
    expect(p).toMatchObject({ dias: 10, anteriorDe: "2026-09-21", anteriorAte: "2026-09-30" });
    expect(periodoDe({ periodo: "7d" }).dias).toBe(7);
    expect(periodoDe({ periodo: "hoje" }).de).toBe(diaLocal());
  });

  it("próxima execução de agendamentos", () => {
    const base = new Date("2026-10-16T12:00:00Z"); // 09:00 em Brasília, sexta
    expect(proximaExecucao({ frequencia: "diaria", horario: "08:00" }, base).toISOString()).toBe("2026-10-17T11:00:00.000Z");
    expect(proximaExecucao({ frequencia: "diaria", horario: "10:00" }, base).toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(proximaExecucao({ frequencia: "semanal", horario: "08:00", diaSemana: 1 }, base).toISOString()).toBe("2026-10-19T11:00:00.000Z");
    expect(proximaExecucao({ frequencia: "mensal", horario: "07:30", diaMes: 5 }, base).toISOString()).toBe("2026-11-05T10:30:00.000Z");
  });
});

describe("normalizações", () => {
  it("BR no formato da PRF e placa sem máscara", () => {
    expect(["BR-040", "040", "br 116", "381"].map(normalizarBr)).toEqual(["40", "40", "116", "381"]);
    expect(normalizarPlaca("abc-1d23")).toBe("ABC1D23");
  });

  it("texto do PDF só com caracteres que a fonte padrão codifica", () => {
    expect(textoPdf("São Paulo → Rio ≥ 70 ✓")).toBe("São Paulo -> Rio >= 70 ok");
    expect(textoPdf("emoji 🚚 fora")).toBe("emoji  fora");
  });
});
