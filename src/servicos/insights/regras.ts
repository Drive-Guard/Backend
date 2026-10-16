/**
 * Insights por regras: o caminho sem IA (sem chave configurada, cota da camada
 * gratuita esgotada ou resposta inválida do modelo). Usa só o contexto, então
 * roda igual dentro e fora da VPC.
 */

import { formatarNumero, formatarReais } from "../../lib/numeros";
import type { ConteudoInsights, ContextoInsights } from "./tipos";

type Recomendacao = ConteudoInsights["recomendacoes"][number];

export function gerarPorRegras(c: ContextoInsights): ConteudoInsights {
  const rec: Recomendacao[] = [];
  const fr = c.frota;

  // 1. Motoristas acima do limite agora, com muitas horas de turno.
  const cansados = c.emRiscoAgora.filter((m) => (m.horasTurno ?? 0) >= 5);
  if (c.emRiscoAgora.length > 0) {
    rec.push({
      titulo: `Pausa recomendada para ${c.emRiscoAgora.length} motorista${c.emRiscoAgora.length > 1 ? "s" : ""}`,
      descricao:
        `Score de fadiga acima de 70 agora em ${c.emRiscoAgora.map((m) => m.codigo).slice(0, 5).join(", ")}` +
        (cansados.length ? `; ${cansados.length} com mais de 5 h de turno.` : "."),
      severidade: c.emRiscoAgora.some((m) => m.score >= 85) ? "critica" : "alta",
      acao_sugerida: "Solicitar pausa de 20 minutos",
      metrica: `em_risco_agora=${c.emRiscoAgora.length}`,
    });
  }

  // 2. Concentração de alertas num horário.
  if (c.horarioCritico && (c.horarioCritico.percentual ?? 0) >= 20) {
    const madrugada = (c.horarioCritico.madrugadaPercentual ?? 0) >= 40;
    rec.push({
      titulo: madrugada ? "Padrão crítico na madrugada" : `Pico de alertas entre ${c.horarioCritico.inicio} e ${c.horarioCritico.fim}`,
      descricao:
        `${c.horarioCritico.percentual}% dos alertas dos últimos 7 dias ocorreram entre ${c.horarioCritico.inicio} e ${c.horarioCritico.fim}` +
        (madrugada ? ` e ${c.horarioCritico.madrugadaPercentual}% entre 0h e 6h.` : ".") +
        (c.prf?.madrugadaPercentual ? ` Na base da PRF, ${c.prf.madrugadaPercentual}% dos acidentes por sono de veículos pesados são de madrugada.` : ""),
      severidade: madrugada ? "critica" : "alta",
      acao_sugerida: madrugada ? "Revisar a escala noturna" : "Reforçar pausas nesse horário",
      metrica: `horario_critico=${c.horarioCritico.inicio}-${c.horarioCritico.fim}`,
    });
  }

  // 3. Hora do turno em que a fadiga passa do limite.
  const acima = c.fadigaPorHoraDirecao.find((p) => (p.fadiga ?? 0) >= 70);
  if (acima) {
    rec.push({
      titulo: `Fadiga passa do limite a partir de ${acima.hora} de direção`,
      descricao: `A fadiga média da frota chega a ${acima.fadiga} na ${acima.hora} do turno. Uma parada antes desse ponto reduz o risco.`,
      severidade: "alta",
      acao_sugerida: `Programar parada antes de ${acima.hora} de direção`,
      metrica: `hora_limite=${acima.hora}`,
    });
  }

  // 4. Rota mais cansativa, com o histórico da PRF nas BRs dela.
  const rota = c.rotas[0];
  if (rota && rota.fadiga !== null && rota.fadiga >= 50) {
    rec.push({
      titulo: `Rota ${rota.rota} com a maior fadiga`,
      descricao:
        `Fadiga média de ${rota.fadiga} e ${rota.alertas} alertas na semana` +
        (rota.prfAcidentesSono ? `; as BRs da rota tiveram ${rota.prfAcidentesSono} acidentes por sono nos últimos 12 meses (PRF).` : "."),
      severidade: rota.fadiga >= 70 ? "alta" : "media",
      acao_sugerida: "Planejar paradas e revezamento nessa rota",
      metrica: `rota=${rota.rota}`,
    });
  }

  // 5. Tendência da semana.
  if (fr.variacaoFadigaPercentual !== null && Math.abs(fr.variacaoFadigaPercentual) >= 5) {
    const subiu = fr.variacaoFadigaPercentual > 0;
    rec.push({
      titulo: subiu ? `Fadiga da frota subiu ${fr.variacaoFadigaPercentual}% na semana` : `Fadiga da frota caiu ${-fr.variacaoFadigaPercentual}% na semana`,
      descricao: `Média de ${fr.fadigaMedia7d} nos últimos 7 dias, contra ${fr.fadigaMedia7dAnterior} na semana anterior.`,
      severidade: subiu ? (fr.variacaoFadigaPercentual >= 15 ? "alta" : "media") : "baixa",
      acao_sugerida: subiu ? "Investigar jornadas e horários da semana" : "Manter as medidas adotadas",
      metrica: `variacao_fadiga=${fr.variacaoFadigaPercentual}%`,
    });
  }

  // 6. Alertas graves sem tratamento.
  if (fr.alertasAbertosGraves >= 3) {
    rec.push({
      titulo: `${fr.alertasAbertosGraves} alertas graves sem atendimento`,
      descricao:
        `Alertas de gravidade alta ou crítica da semana ainda abertos.` +
        (c.atendimento.percentual !== null ? ` Nos últimos 30 dias, ${c.atendimento.percentual}% dos alertas graves tiveram pausa ou troca registrada.` : ""),
      severidade: "alta",
      acao_sugerida: "Tratar os alertas abertos na aba Monitoramento",
      metrica: `alertas_abertos_graves=${fr.alertasAbertosGraves}`,
    });
  }

  // 7. Impacto estimado.
  if (c.roi?.disponivel && c.roi.custoEvitadoAno) {
    rec.push({
      titulo: `Redução potencial de ${c.roi.reducaoPercentual}% nos acidentes por sono`,
      descricao: `Com a cobertura atual, a estimativa conservadora é evitar ${formatarNumero(c.roi.acidentesEvitadosAno, 1)} acidente(s) por ano, cerca de ${formatarReais(c.roi.custoEvitadoAno)}.`,
      severidade: "baixa",
      acao_sugerida: "Ampliar a cobertura de câmeras na frota",
      metrica: `custo_evitado_ano=${c.roi.custoEvitadoAno}`,
    });
  }

  if (rec.length === 0) {
    rec.push({
      titulo: "Operação dentro do esperado",
      descricao: "Nenhum padrão crítico identificado nos últimos 7 dias.",
      severidade: "baixa",
      acao_sugerida: "Manter o monitoramento",
      metrica: "",
    });
  }

  // Motoristas: um insight para cada um dos mais críticos.
  const motoristas = c.motoristasRisco
    .filter((m) => m.nivel === "critical" || m.nivel === "high" || m.alertasGraves30d >= 5)
    .slice(0, 5)
    .map((m) => ({
      codigo: m.codigo,
      titulo: m.alertasGraves30d >= 5 ? "Alertas graves recorrentes" : "Fadiga média elevada",
      descricao: `Fadiga média de ${m.fadigaMedia30d} e ${m.alertasGraves30d} alertas graves em 30 dias (${formatarNumero(m.horasDirigidas30d, 0)} h dirigidas).`,
      severidade: (m.nivel === "critical" ? "critica" : "alta") as "critica" | "alta",
    }));

  return { recomendacoes: rec.slice(0, 6), resumo: resumoPorRegras(c), motoristas };
}

export function resumoPorRegras(c: ContextoInsights): string[] {
  const frases: string[] = [];
  const fr = c.frota;
  if (fr.variacaoFadigaPercentual !== null) {
    frases.push(
      fr.variacaoFadigaPercentual >= 0
        ? `A fadiga média subiu ${fr.variacaoFadigaPercentual}% em relação à semana anterior (${fr.fadigaMedia7d} contra ${fr.fadigaMedia7dAnterior}).`
        : `A fadiga média caiu ${-fr.variacaoFadigaPercentual}% em relação à semana anterior (${fr.fadigaMedia7d} contra ${fr.fadigaMedia7dAnterior}).`,
    );
  } else if (fr.fadigaMedia7d !== null) {
    frases.push(`A fadiga média da frota na semana foi de ${fr.fadigaMedia7d}.`);
  }
  if (c.horarioCritico) {
    frases.push(`A maior concentração de alertas ocorreu entre ${c.horarioCritico.inicio} e ${c.horarioCritico.fim} (${c.horarioCritico.percentual}% do total).`);
  }
  const tipo = c.porTipoVeiculo.find((t) => t.fadiga !== null && t.tipo !== "Não informado");
  if (tipo) frases.push(`${tipo.tipo} apresentou o maior score médio de fadiga (${tipo.fadiga}).`);
  const rota = [...c.rotas].sort((a, b) => b.alertas - a.alertas)[0];
  if (rota && rota.alertas > 0) frases.push(`A rota ${rota.rota} concentrou o maior número de alertas (${rota.alertas}).`);
  frases.push(
    fr.alertasAbertosGraves > 0
      ? `Há ${fr.alertasAbertosGraves} alertas graves em aberto: tratar esses casos e manter pausas preventivas reduz o risco operacional.`
      : "As pausas preventivas continuam sendo a medida mais efetiva para reduzir os riscos operacionais.",
  );
  return frases;
}
