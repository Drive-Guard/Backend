/**
 * Confere a coerência da simulação do seed (Infra/sql/05_seed_demo.sql):
 * volume, fases piloto x operação, estados, alertas, ações, acidentes,
 * fadiga por hora e o parâmetro de ROI derivado.
 *
 *   npx tsx scripts/estatisticas-seed.ts            # banco local
 *   DATABASE_URL=... npx tsx scripts/estatisticas-seed.ts
 */

import postgres from "postgres";
import { URL_LOCAL } from "./migrar";

const sql = postgres(process.env.DATABASE_URL ?? URL_LOCAL, { max: 1 });

const consultas: [string, string][] = [
  ["Volume", `
    SELECT (SELECT count(*) FROM silver.turnos) turnos,
           (SELECT count(*) FROM silver.turnos WHERE status = 'em_andamento') abertos,
           (SELECT count(*) FROM silver.leituras_fadiga) leituras,
           (SELECT count(*) FROM silver.alertas) alertas,
           (SELECT count(*) FROM silver.acoes_motorista) acoes,
           (SELECT count(*) FROM silver.incidentes WHERE origem = 'interno') acidentes`],
  ["Leituras por fase", `
    WITH f AS (SELECT min(iniciado_em) + (max(iniciado_em) - min(iniciado_em)) * 0.25 AS c1,
                      min(iniciado_em) + (max(iniciado_em) - min(iniciado_em)) * 0.5 AS c2 FROM silver.turnos)
    SELECT CASE WHEN t.iniciado_em < f.c1 THEN '1 piloto' WHEN t.iniciado_em < f.c2 THEN '2 central' ELSE '3 programa' END fase,
           count(DISTINCT t.id)::int turnos, round(avg(l.score_fadiga), 1)::float score_medio,
           round(100.0 * count(*) FILTER (WHERE l.estado = 'alerta') / count(*), 1)::float pct_alerta,
           round(100.0 * count(*) FILTER (WHERE l.estado = 'fadiga') / count(*), 1)::float pct_fadiga,
           round(100.0 * count(*) FILTER (WHERE l.estado = 'sonolento') / count(*), 1)::float pct_sonolento
      FROM silver.turnos t CROSS JOIN f JOIN silver.leituras_fadiga l ON l.turno_id = t.id
     GROUP BY 1 ORDER BY 1`],
  ["Alertas por fase", `
    WITH f AS (SELECT min(iniciado_em) + (max(iniciado_em) - min(iniciado_em)) * 0.25 AS c1,
                      min(iniciado_em) + (max(iniciado_em) - min(iniciado_em)) * 0.5 AS c2 FROM silver.turnos)
    SELECT CASE WHEN a.disparado_em < f.c1 THEN '1 piloto' WHEN a.disparado_em < f.c2 THEN '2 central' ELSE '3 programa' END fase,
           count(*)::int alertas, round(count(*)::numeric / count(DISTINCT a.disparado_em::date), 1)::float por_dia,
           count(*) FILTER (WHERE gravidade = 'critica')::int criticos,
           count(*) FILTER (WHERE gravidade = 'alta')::int altos,
           count(*) FILTER (WHERE gravidade = 'media')::int medios
      FROM silver.alertas a CROSS JOIN f GROUP BY 1 ORDER BY 1`],
  ["Tipos de alerta", `SELECT tipo::text, count(*)::int FROM silver.alertas GROUP BY 1 ORDER BY 2 DESC`],
  ["Ações", `SELECT tipo::text, count(*)::int total, count(*) FILTER (WHERE eficaz)::int eficazes FROM silver.acoes_motorista GROUP BY 1`],
  ["Acidentes da frota", `
    SELECT origem_id_externo id, to_char(ocorrido_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YY HH24:MI') quando, m.codigo,
           relacionado_sonolencia sono, COALESCE(gravidade::text, 'quase') gravidade, left(descricao, 70) descricao
      FROM silver.incidentes i JOIN silver.motoristas m ON m.id = i.motorista_id
     WHERE origem = 'interno' ORDER BY ocorrido_em`],
  ["Fadiga média por mês", `
    SELECT to_char(registrado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') mes, round(avg(score_fadiga), 1)::float score,
           round(100.0 * count(*) FILTER (WHERE estado = 'sonolento') / count(*), 1)::float pct_sonolento
      FROM silver.leituras_fadiga GROUP BY 1 ORDER BY 1`],
  ["Treinados: fadiga 30 dias antes x depois", `
    SELECT m.codigo, to_char(a.realizado_em, 'DD/MM/YY') treino, a.eficaz,
           (SELECT round(avg(score_fadiga), 1)::float FROM silver.leituras_fadiga l WHERE l.motorista_id = a.motorista_id
             AND l.registrado_em BETWEEN a.realizado_em - interval '30 days' AND a.realizado_em) antes,
           (SELECT round(avg(score_fadiga), 1)::float FROM silver.leituras_fadiga l WHERE l.motorista_id = a.motorista_id
             AND l.registrado_em BETWEEN a.realizado_em + interval '45 days' AND a.realizado_em + interval '75 days') depois
      FROM silver.acoes_motorista a JOIN silver.motoristas m ON m.id = a.motorista_id WHERE a.tipo = 'treinamento' ORDER BY 1`],
  ["Motoristas", `
    SELECT m.codigo, m.status::text, count(DISTINCT t.id)::int turnos, round(avg(l.score_fadiga), 1)::float score,
           max(l.score_fadiga)::float pico,
           (SELECT count(*) FROM silver.alertas a WHERE a.motorista_id = m.id)::int alertas
      FROM silver.motoristas m JOIN silver.turnos t ON t.motorista_id = m.id JOIN silver.leituras_fadiga l ON l.turno_id = t.id
     GROUP BY m.id, m.codigo, m.status ORDER BY m.codigo`],
  ["Fadiga por hora do dia", `
    SELECT extract(hour FROM registrado_em AT TIME ZONE 'America/Sao_Paulo')::int hora, round(avg(score_fadiga), 1)::float score, count(*)::int leituras
      FROM silver.leituras_fadiga GROUP BY 1 ORDER BY 1`],
  ["Fadiga por hora de turno", `
    SELECT floor(extract(epoch FROM l.registrado_em - t.iniciado_em) / 3600)::int hora_turno, round(avg(score_fadiga), 1)::float score, count(*)::int leituras
      FROM silver.leituras_fadiga l JOIN silver.turnos t ON t.id = l.turno_id GROUP BY 1 ORDER BY 1`],
  ["Turnos em andamento", `
    SELECT m.codigo, to_char(t.iniciado_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') inicio,
           (SELECT score_fadiga::float FROM silver.leituras_fadiga l WHERE l.turno_id = t.id ORDER BY registrado_em DESC LIMIT 1) score_agora,
           (SELECT string_agg(status::text, ',' ORDER BY disparado_em) FROM silver.alertas a WHERE a.turno_id = t.id) alertas
      FROM silver.turnos t JOIN silver.motoristas m ON m.id = t.motorista_id WHERE t.status = 'em_andamento' ORDER BY 1`],
  ["Status dos turnos", `SELECT status::text, count(*)::int FROM silver.turnos GROUP BY 1`],
  ["ROI", `SELECT chave, valor::float, fonte FROM silver.parametros_roi`],
];

async function main() {
  for (const [titulo, q] of consultas) {
    console.log(`\n== ${titulo}`);
    console.table(await sql.unsafe(q));
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
