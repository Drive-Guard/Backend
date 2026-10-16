/**
 * Impacto estimado (ROI) do DriveGuard.
 *
 * Fórmula (por ano, dois cenários pela fração de acidentes ligada ao sono):
 *
 *   acidentes por sono   = acidentes da frota no ano x fração de sono
 *   acidentes evitados   = acidentes por sono x eficácia do alerta x cobertura
 *   custo evitado        = evitados x custo médio por acidente (IPEA, corrigido pelo IPCA)
 *   vidas preservadas    = evitados x mortos por acidente (PRF: pesados + sono)
 *   horas de parada      = evitados x horas paradas por acidente (gestor)
 *   custo do atraso      = horas de parada x valor/hora das viagens (gestor)
 *
 *   cobertura = veículos com câmera ativa / tamanho da frota
 *
 * "Acidente evitado" é a hipótese de que um alerta de sonolência emitido, sem
 * acidente depois, evitou o acidente que a literatura associa ao sono. Cada
 * número tem fonte, e o gestor pode trocar os seus pela tela de parâmetros.
 */

import { db, type Sql } from "../lib/db";
import { arred } from "../lib/numeros";

export interface Parametro {
  chave: string;
  valor: number | null;
  valorPadrao: number | null;
  unidade: string;
  descricao: string;
  fonte: string | null;
  urlFonte: string | null;
  referencia: string | null;
  editavel: boolean;
  personalizado: boolean;
}

/**
 * Rótulo neutro para quando a empresa troca o valor: a descrição padrão
 * cita o estudo de onde veio o número, que deixa de valer.
 */
const DESCRICAO_PERSONALIZADA: Record<string, string> = {
  fracao_sono_conservador: "Fração dos acidentes ligada ao sono (cenário conservador).",
  fracao_sono_realista: "Fração dos acidentes ligada ao sono (cenário realista).",
  eficacia_alerta: "Redução dos eventos de fadiga com o alarme ligado.",
};

export async function parametros(empresaId: string, sql: Sql = db()): Promise<Record<string, Parametro>> {
  const linhas = await sql`
    SELECT p.chave, p.valor AS padrao, p.unidade, p.descricao, p.fonte, p.url_fonte, p.referencia, p.editavel,
           e.valor AS da_empresa, e.fonte AS fonte_empresa
      FROM silver.parametros_roi_padrao p
      LEFT JOIN silver.parametros_roi e ON e.chave = p.chave AND e.empresa_id = ${empresaId}
     ORDER BY p.chave
  `;
  const mapa: Record<string, Parametro> = {};
  for (const l of linhas) {
    const personalizado = l.da_empresa !== null && l.da_empresa !== undefined;
    mapa[l.chave as string] = {
      chave: l.chave as string,
      valor: personalizado ? (l.da_empresa as number) : (l.padrao as number | null),
      valorPadrao: l.padrao as number | null,
      unidade: l.unidade as string,
      descricao: personalizado ? (DESCRICAO_PERSONALIZADA[l.chave as string] ?? (l.descricao as string)) : (l.descricao as string),
      fonte: personalizado ? ((l.fonte_empresa as string) ?? "Informado pela empresa") : (l.fonte as string | null),
      urlFonte: personalizado ? null : (l.url_fonte as string | null),
      // A referência (ano do estudo) é do valor padrão.
      referencia: personalizado ? null : (l.referencia as string | null),
      editavel: l.editavel as boolean,
      personalizado,
    };
  }
  return mapa;
}

/** Perfil dos acidentes de caminhão/ônibus com condutor dormindo (PRF). */
async function perfilPrf(sql: Sql) {
  // Ano completo mais recente; se só houver o ano corrente, usa ele.
  const linhas = await sql`
    SELECT ano, acidentes, fatais, com_feridos, sem_vitimas, mortos
      FROM gold.mv_prf_perfil_sono
     WHERE recorte = 'pesados_sono'
     ORDER BY (ano < EXTRACT(YEAR FROM now())::int) DESC, ano DESC
     LIMIT 1
  `;
  const p = linhas[0];
  if (!p || !(p.acidentes as number)) return null;
  const n = p.acidentes as number;
  return {
    ano: p.ano as number,
    acidentes: n,
    proporcaoFatal: (p.fatais as number) / n,
    proporcaoFeridos: (p.com_feridos as number) / n,
    proporcaoSemVitimas: (p.sem_vitimas as number) / n,
    mortosPorAcidente: (p.mortos as number) / n,
  };
}

async function cobertura(sql: Sql, empresaId: string) {
  const [c] = await sql`
    SELECT e.frota_total,
           (SELECT COUNT(DISTINCT vd.veiculo_id)
              FROM silver.vinculos_dispositivo_veiculo vd
              JOIN silver.dispositivos d ON d.id = vd.dispositivo_id
              JOIN silver.veiculos v ON v.id = vd.veiculo_id
             WHERE vd.fim IS NULL AND d.status = 'ativo' AND v.empresa_id = e.id AND v.ativo)::int AS com_camera,
           (SELECT COUNT(*) FROM silver.veiculos v WHERE v.empresa_id = e.id AND v.ativo)::int AS cadastrados
      FROM silver.empresas e
     WHERE e.id = ${empresaId}
  `;
  const frota = (c?.frota_total as number | null) ?? (c?.cadastrados as number) ?? 0;
  const comCamera = (c?.com_camera as number) ?? 0;
  return {
    veiculosComCamera: comCamera,
    frotaTotal: frota,
    frotaInformada: c?.frota_total !== null && c?.frota_total !== undefined,
    fracao: frota > 0 ? Math.min(1, comCamera / frota) : 0,
  };
}

/** Valor médio por hora das viagens com valor e previsão de chegada (90 dias). */
async function valorHoraViagens(sql: Sql, empresaId: string) {
  const [v] = await sql`
    SELECT AVG(valor_viagem / NULLIF(EXTRACT(EPOCH FROM (chegada_prevista - partida_prevista)) / 3600.0, 0)) AS valor_hora,
           COUNT(*)::int AS viagens
      FROM silver.viagens
     WHERE empresa_id = ${empresaId}
       AND valor_viagem IS NOT NULL AND chegada_prevista IS NOT NULL
       AND partida_prevista >= now() - interval '90 days'
       AND status <> 'cancelada'
  `;
  return { valorHora: v?.valor_hora as number | null, viagens: (v?.viagens as number) ?? 0 };
}

/** Alertas graves (30 dias) com ação de pausa, troca ou encerramento registrada. */
async function alertasAtendidos(sql: Sql, empresaId: string) {
  const [a] = await sql`
    SELECT COALESCE(SUM(total), 0)::int AS graves, COALESCE(SUM(atendidos), 0)::int AS atendidos
      FROM gold.mv_alertas_agregados
     WHERE empresa_id = ${empresaId} AND gravidade IN ('alta', 'critica')
       AND dia >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 29
  `;
  const graves = (a?.graves as number) ?? 0;
  const atendidos = (a?.atendidos as number) ?? 0;
  return { graves, atendidos, percentual: graves ? arred((atendidos / graves) * 100, 0) : null };
}

export interface Cenario {
  fracaoSono: number;
  acidentesPorSono: number;
  acidentesEvitados: number;
  custoEvitado: number;
  vidasPreservadas: number;
  horasParadaEvitadas: number | null;
  custoAtrasoEvitado: number | null;
}

export async function calcular(empresaId: string, sql: Sql = db()) {
  const [p, prf, cob, viagens, atendidos] = await Promise.all([
    parametros(empresaId, sql),
    perfilPrf(sql),
    cobertura(sql, empresaId),
    valorHoraViagens(sql, empresaId),
    alertasAtendidos(sql, empresaId),
  ]);

  const v = (chave: string) => p[chave]?.valor ?? null;
  const acidentesAno = v("acidentes_ano_frota");
  const eficacia = v("eficacia_alerta") ?? 0.5;
  const ipca = v("fator_ipca") ?? 1;

  const proporcoes = prf
    ? { fatal: prf.proporcaoFatal, feridos: prf.proporcaoFeridos, semVitimas: prf.proporcaoSemVitimas, fonte: `PRF ${prf.ano}: ${prf.acidentes} acidentes de caminhão/ônibus com condutor dormindo` }
    : {
        fatal: v("proporcao_fatal_padrao") ?? 0.04,
        feridos: v("proporcao_feridos_padrao") ?? 0.37,
        semVitimas: 1 - (v("proporcao_fatal_padrao") ?? 0.04) - (v("proporcao_feridos_padrao") ?? 0.37),
        fonte: "IPEA 2015, tabela 8 (base da PRF ainda não carregada)",
      };
  const mortosPorAcidente = prf ? prf.mortosPorAcidente : (v("mortos_por_acidente_padrao") ?? 0.0627);

  const custoMedio =
    ((v("custo_acidente_fatal") ?? 0) * proporcoes.fatal +
      (v("custo_acidente_feridos") ?? 0) * proporcoes.feridos +
      (v("custo_acidente_sem_vitimas") ?? 0) * proporcoes.semVitimas) *
    ipca;

  const horasParada = v("horas_parada_por_acidente");

  const cenario = (fracao: number): Cenario => {
    const porSono = (acidentesAno ?? 0) * fracao;
    const evitados = porSono * eficacia * cob.fracao;
    const horas = horasParada !== null ? evitados * horasParada : null;
    return {
      fracaoSono: fracao,
      acidentesPorSono: arred(porSono, 2)!,
      acidentesEvitados: arred(evitados, 2)!,
      custoEvitado: Math.round(evitados * custoMedio),
      vidasPreservadas: arred(evitados * mortosPorAcidente, 3)!,
      horasParadaEvitadas: horas !== null ? arred(horas, 1) : null,
      custoAtrasoEvitado: horas !== null && viagens.valorHora ? Math.round(horas * viagens.valorHora) : null,
    };
  };

  const pendencias: string[] = [];
  if (acidentesAno === null) pendencias.push("Informe quantos acidentes a frota teve no último ano (Cadastros > Parâmetros do ROI).");
  if (horasParada === null) pendencias.push("Informe quantas horas a operação fica parada depois de um acidente, para estimar o custo do atraso.");
  if (!cob.frotaInformada) pendencias.push("Informe o tamanho total da frota (Cadastros > Empresa); a cobertura está usando os veículos cadastrados.");
  if (!viagens.viagens) pendencias.push("Cadastre viagens com valor e previsão de chegada para estimar o custo do atraso.");

  return {
    disponivel: acidentesAno !== null,
    pendencias,
    reducaoAcidentesSonoPercentual: arred(eficacia * cob.fracao * 100, 0),
    cenarios: {
      conservador: cenario(v("fracao_sono_conservador") ?? 0.028),
      realista: cenario(v("fracao_sono_realista") ?? 0.06),
    },
    custoMedioPorAcidente: Math.round(custoMedio),
    proporcoesGravidade: {
      fatal: arred(proporcoes.fatal, 4),
      feridos: arred(proporcoes.feridos, 4),
      semVitimas: arred(proporcoes.semVitimas, 4),
      fonte: proporcoes.fonte,
    },
    mortosPorAcidente: arred(mortosPorAcidente, 4),
    cobertura: { ...cob, fracao: arred(cob.fracao, 3) },
    valorHoraViagens: viagens.valorHora !== null ? Math.round(viagens.valorHora) : null,
    alertasAtendidos30d: atendidos,
    parametros: Object.values(p),
    nota:
      "Estimativa anual. \"Acidente evitado\" supõe que o alerta emitido na cabine, seguido de pausa, evita o acidente " +
      "que a literatura associa ao sono. Os cenários usam a fração de sono registrada pela PRF (conservador, " +
      "subnotificada) e " +
      (p.fracao_sono_realista?.personalizado
        ? `a fração ligada ao sono no histórico da própria frota (realista: ${p.fracao_sono_realista.fonte}).`
        : "a medida em investigação aprofundada (realista)."),
  };
}
