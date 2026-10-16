/**
 * Documento de relatório independente do formato. Os renderizadores (PDF,
 * Excel, CSV) recebem isto; os dados de cada tipo de relatório só montam isto.
 */

export type Valor = string | number | null;

export interface Kpi {
  rotulo: string;
  valor: string;
  detalhe?: string;
}

export interface Tabela {
  colunas: { titulo: string; largura?: number; numero?: boolean }[];
  linhas: Valor[][];
  /** Nome curto para a aba do Excel. */
  aba?: string;
}

export interface Secao {
  titulo: string;
  kpis?: Kpi[];
  texto?: string[];
  tabela?: Tabela;
}

export interface Documento {
  titulo: string;
  subtitulo: string;
  empresa: string;
  geradoEm: Date;
  secoes: Secao[];
}

export const TIPOS_RELATORIO = ["executivo", "operacional", "motoristas", "frota", "alertas"] as const;
export const FORMATOS = ["pdf", "xlsx", "csv"] as const;
export type TipoRelatorio = (typeof TIPOS_RELATORIO)[number];
export type Formato = (typeof FORMATOS)[number];

export const TITULO_RELATORIO: Record<TipoRelatorio, string> = {
  executivo: "Relatório Executivo",
  operacional: "Relatório Operacional",
  motoristas: "Relatório de Motoristas",
  frota: "Relatório da Frota",
  alertas: "Histórico de Alertas",
};

export const MIME: Record<Formato, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};
