/**
 * Manifesto das rotas da API.
 *
 * É a fonte única de verdade: o serverless.ts gera daqui os eventos httpApi
 * de cada Lambda (todos com o autorizador JWT do Cognito), e o roteador de
 * cada função usa o mesmo manifesto para achar a ação e checar o papel.
 *
 * Só dados aqui: o serverless.ts importa este arquivo no deploy.
 */

import type { Papel } from "./lib/auth";

export type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Lambdas da API. As que falam com o banco rodam na VPC; "usuarios" fala com o Cognito e fica fora. */
export type FuncaoApi = "dashboard" | "motoristas" | "alertas" | "relatorios" | "cadastros" | "usuarios";

export interface Rota {
  metodo: Metodo;
  caminho: string;
  funcao: FuncaoApi;
  acao: string;
  papeis: readonly Papel[];
  descricao: string;
}

const TODOS = ["admin", "gestor", "operador"] as const;
const GESTAO = ["admin", "gestor"] as const;
const ADMIN = ["admin"] as const;

export const rotas: Rota[] = [
  // ------------------------------------------------------------ sessão
  { metodo: "GET", caminho: "/me", funcao: "dashboard", acao: "me", papeis: TODOS, descricao: "Usuário logado, papéis e empresa" },

  // ------------------------------------------------------- visão geral
  { metodo: "GET", caminho: "/dashboard/kpis", funcao: "dashboard", acao: "kpis", papeis: TODOS, descricao: "KPIs do topo (ao vivo e do período)" },
  { metodo: "GET", caminho: "/dashboard/alertas-tempo-real", funcao: "dashboard", acao: "alertasTempoReal", papeis: TODOS, descricao: "Motoristas com fadiga alta agora" },
  { metodo: "GET", caminho: "/dashboard/tendencia-turno", funcao: "dashboard", acao: "tendenciaTurno", papeis: TODOS, descricao: "Fadiga média por hora de direção e sinais detectados" },
  { metodo: "GET", caminho: "/dashboard/evolucao-fadiga", funcao: "dashboard", acao: "evolucaoFadiga", papeis: TODOS, descricao: "Fadiga média diária no período" },
  { metodo: "GET", caminho: "/dashboard/rotas", funcao: "dashboard", acao: "rotas", papeis: TODOS, descricao: "Rotas com maior incidência, com o cruzamento da PRF" },
  { metodo: "GET", caminho: "/dashboard/heatmap", funcao: "dashboard", acao: "heatmap", papeis: TODOS, descricao: "Horas de direção x dia (últimos 7 dias ou intervalo)" },
  { metodo: "GET", caminho: "/dashboard/fadiga-tempo-direcao", funcao: "dashboard", acao: "fadigaTempoDirecao", papeis: TODOS, descricao: "Fadiga e alertas por faixa de horas ao volante" },
  { metodo: "GET", caminho: "/dashboard/prf/resumo", funcao: "dashboard", acao: "prfResumo", papeis: TODOS, descricao: "Resumo da base da PRF carregada" },
  { metodo: "GET", caminho: "/dashboard/prf/faixa-horaria", funcao: "dashboard", acao: "prfFaixaHoraria", papeis: TODOS, descricao: "Acidentes por faixa horária (PRF)" },
  { metodo: "GET", caminho: "/dashboard/prf/causas", funcao: "dashboard", acao: "prfCausas", papeis: TODOS, descricao: "Principais causas de acidentes (PRF)" },
  { metodo: "GET", caminho: "/dashboard/prf/mapa", funcao: "dashboard", acao: "prfMapa", papeis: TODOS, descricao: "Cidades com mais acidentes por sono (PRF)" },
  { metodo: "GET", caminho: "/dashboard/insights", funcao: "dashboard", acao: "insights", papeis: TODOS, descricao: "Insights e recomendações mais recentes" },
  { metodo: "POST", caminho: "/dashboard/insights/gerar", funcao: "dashboard", acao: "gerarInsights", papeis: GESTAO, descricao: "Pede uma nova rodada de insights" },
  { metodo: "GET", caminho: "/dashboard/roi", funcao: "dashboard", acao: "roi", papeis: GESTAO, descricao: "Impacto estimado (ROI) com fontes" },
  { metodo: "GET", caminho: "/dashboard/exportar", funcao: "dashboard", acao: "exportar", papeis: TODOS, descricao: "CSV com o estado atual dos motoristas" },

  // -------------------------------------------------------- motoristas
  { metodo: "GET", caminho: "/motoristas/ao-vivo", funcao: "motoristas", acao: "aoVivo", papeis: TODOS, descricao: "Lista ao vivo dos motoristas" },
  { metodo: "GET", caminho: "/motoristas/{id}", funcao: "motoristas", acao: "detalhe", papeis: TODOS, descricao: "Indicadores de 30 dias e estado atual" },
  { metodo: "GET", caminho: "/motoristas/{id}/curva-turno", funcao: "motoristas", acao: "curvaTurno", papeis: TODOS, descricao: "Fadiga hora a hora no último turno" },
  { metodo: "GET", caminho: "/motoristas/{id}/insights", funcao: "motoristas", acao: "insights", papeis: TODOS, descricao: "Insights do motorista" },
  { metodo: "GET", caminho: "/motoristas/{id}/alertas", funcao: "motoristas", acao: "alertas", papeis: TODOS, descricao: "Alertas recentes do motorista" },
  { metodo: "POST", caminho: "/motoristas/{id}/acoes", funcao: "motoristas", acao: "registrarAcao", papeis: TODOS, descricao: "Registra uma ação (ex.: pausa solicitada)" },
  { metodo: "POST", caminho: "/motoristas/{id}/ocorrencias", funcao: "motoristas", acao: "registrarOcorrencia", papeis: TODOS, descricao: "Registra uma ocorrência interna" },

  // ------------------------------------------------------------ alertas
  { metodo: "GET", caminho: "/alertas", funcao: "alertas", acao: "listar", papeis: TODOS, descricao: "Alertas da frota" },
  { metodo: "PATCH", caminho: "/alertas/{id}", funcao: "alertas", acao: "atualizar", papeis: TODOS, descricao: "Reconhece, resolve ou descarta um alerta" },

  // --------------------------------------------------------- relatórios
  { metodo: "GET", caminho: "/relatorios/resumo", funcao: "relatorios", acao: "resumo", papeis: GESTAO, descricao: "KPIs, gráficos e resumo inteligente do período" },
  { metodo: "GET", caminho: "/relatorios", funcao: "relatorios", acao: "listar", papeis: GESTAO, descricao: "Relatórios gerados" },
  { metodo: "POST", caminho: "/relatorios", funcao: "relatorios", acao: "gerar", papeis: GESTAO, descricao: "Gera um relatório (PDF, Excel ou CSV)" },
  { metodo: "GET", caminho: "/relatorios/{id}/download", funcao: "relatorios", acao: "download", papeis: GESTAO, descricao: "Link temporário para baixar o arquivo" },
  { metodo: "GET", caminho: "/relatorios/agendamentos", funcao: "relatorios", acao: "listarAgendamentos", papeis: GESTAO, descricao: "Agendamentos de envio" },
  { metodo: "POST", caminho: "/relatorios/agendamentos", funcao: "relatorios", acao: "criarAgendamento", papeis: GESTAO, descricao: "Cria um agendamento" },
  { metodo: "PUT", caminho: "/relatorios/agendamentos/{id}", funcao: "relatorios", acao: "atualizarAgendamento", papeis: GESTAO, descricao: "Altera um agendamento" },
  { metodo: "DELETE", caminho: "/relatorios/agendamentos/{id}", funcao: "relatorios", acao: "removerAgendamento", papeis: GESTAO, descricao: "Remove um agendamento" },

  // ---------------------------------------------------------- cadastros
  { metodo: "GET", caminho: "/cadastros/empresa", funcao: "cadastros", acao: "empresa", papeis: GESTAO, descricao: "Dados da empresa" },
  { metodo: "PUT", caminho: "/cadastros/empresa", funcao: "cadastros", acao: "atualizarEmpresa", papeis: GESTAO, descricao: "Altera nome e tamanho da frota" },
  { metodo: "GET", caminho: "/cadastros/ufs", funcao: "cadastros", acao: "ufs", papeis: TODOS, descricao: "UFs e macro-regiões" },
  { metodo: "GET", caminho: "/cadastros/motoristas", funcao: "cadastros", acao: "listarMotoristas", papeis: GESTAO, descricao: "Motoristas cadastrados e não cadastrados" },
  { metodo: "POST", caminho: "/cadastros/motoristas", funcao: "cadastros", acao: "criarMotorista", papeis: GESTAO, descricao: "Cadastra (ou completa) um motorista pelo código" },
  { metodo: "PUT", caminho: "/cadastros/motoristas/{id}", funcao: "cadastros", acao: "atualizarMotorista", papeis: GESTAO, descricao: "Altera um motorista" },
  { metodo: "GET", caminho: "/cadastros/veiculos", funcao: "cadastros", acao: "listarVeiculos", papeis: GESTAO, descricao: "Veículos e a câmera de cada um" },
  { metodo: "POST", caminho: "/cadastros/veiculos", funcao: "cadastros", acao: "criarVeiculo", papeis: GESTAO, descricao: "Cadastra um veículo" },
  { metodo: "PUT", caminho: "/cadastros/veiculos/{id}", funcao: "cadastros", acao: "atualizarVeiculo", papeis: GESTAO, descricao: "Altera um veículo" },
  { metodo: "GET", caminho: "/cadastros/dispositivos", funcao: "cadastros", acao: "listarDispositivos", papeis: GESTAO, descricao: "Câmeras (inclusive as pendentes)" },
  { metodo: "POST", caminho: "/cadastros/dispositivos", funcao: "cadastros", acao: "criarDispositivo", papeis: GESTAO, descricao: "Pré-cadastra uma câmera" },
  { metodo: "PUT", caminho: "/cadastros/dispositivos/{id}", funcao: "cadastros", acao: "atualizarDispositivo", papeis: GESTAO, descricao: "Altera código, descrição ou status da câmera" },
  { metodo: "POST", caminho: "/cadastros/dispositivos/{id}/vincular", funcao: "cadastros", acao: "vincularDispositivo", papeis: GESTAO, descricao: "Instala a câmera num veículo (troca, se já estiver em outro)" },
  { metodo: "POST", caminho: "/cadastros/dispositivos/{id}/desvincular", funcao: "cadastros", acao: "desvincularDispositivo", papeis: GESTAO, descricao: "Retira a câmera do veículo" },
  { metodo: "GET", caminho: "/cadastros/dispositivos/{id}/historico", funcao: "cadastros", acao: "historicoDispositivo", papeis: GESTAO, descricao: "Em quais veículos a câmera esteve" },
  { metodo: "GET", caminho: "/cadastros/rotas", funcao: "cadastros", acao: "listarRotas", papeis: GESTAO, descricao: "Rotas" },
  { metodo: "POST", caminho: "/cadastros/rotas", funcao: "cadastros", acao: "criarRota", papeis: GESTAO, descricao: "Cadastra uma rota" },
  { metodo: "PUT", caminho: "/cadastros/rotas/{id}", funcao: "cadastros", acao: "atualizarRota", papeis: GESTAO, descricao: "Altera uma rota" },
  { metodo: "GET", caminho: "/cadastros/viagens", funcao: "cadastros", acao: "listarViagens", papeis: GESTAO, descricao: "Viagens" },
  { metodo: "POST", caminho: "/cadastros/viagens", funcao: "cadastros", acao: "criarViagem", papeis: GESTAO, descricao: "Cadastra uma viagem" },
  { metodo: "PUT", caminho: "/cadastros/viagens/{id}", funcao: "cadastros", acao: "atualizarViagem", papeis: GESTAO, descricao: "Altera ou cancela uma viagem" },
  { metodo: "GET", caminho: "/cadastros/parametros-roi", funcao: "cadastros", acao: "listarParametrosRoi", papeis: GESTAO, descricao: "Parâmetros do ROI com as fontes" },
  { metodo: "PUT", caminho: "/cadastros/parametros-roi/{chave}", funcao: "cadastros", acao: "definirParametroRoi", papeis: GESTAO, descricao: "Define o valor da empresa para um parâmetro" },
  { metodo: "DELETE", caminho: "/cadastros/parametros-roi/{chave}", funcao: "cadastros", acao: "restaurarParametroRoi", papeis: GESTAO, descricao: "Volta o parâmetro ao valor padrão" },

  // ----------------------------------------------------------- usuários
  { metodo: "GET", caminho: "/usuarios", funcao: "usuarios", acao: "listar", papeis: ADMIN, descricao: "Usuários da empresa" },
  { metodo: "POST", caminho: "/usuarios", funcao: "usuarios", acao: "criar", papeis: ADMIN, descricao: "Cria um usuário com senha temporária" },
  { metodo: "PATCH", caminho: "/usuarios/{username}", funcao: "usuarios", acao: "atualizar", papeis: ADMIN, descricao: "Troca o papel ou ativa/desativa" },
  { metodo: "DELETE", caminho: "/usuarios/{username}", funcao: "usuarios", acao: "remover", papeis: ADMIN, descricao: "Remove o usuário" },
  { metodo: "POST", caminho: "/usuarios/{username}/redefinir-senha", funcao: "usuarios", acao: "redefinirSenha", papeis: ADMIN, descricao: "Gera uma nova senha temporária" },
];

export const chaveDaRota = (r: Pick<Rota, "metodo" | "caminho">) => `${r.metodo} ${r.caminho}`;
