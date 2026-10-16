/** Renderiza o documento em Excel (exceljs) ou CSV. */

import ExcelJS from "exceljs";
import { celulaCsv } from "../dashboard";
import type { Documento } from "./documento";

export async function renderizarXlsx(d: Documento): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DriveGuard";
  wb.created = d.geradoEm;

  const resumo = wb.addWorksheet("Resumo");
  resumo.columns = [{ width: 42 }, { width: 24 }, { width: 40 }];
  resumo.addRow([d.titulo]).font = { bold: true, size: 16 };
  resumo.addRow([`${d.empresa} • ${d.subtitulo}`]).font = { color: { argb: "FF6B7280" } };
  resumo.addRow([`Gerado em ${d.geradoEm.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`]).font = { color: { argb: "FF6B7280" } };

  const usadas = new Set<string>(["Resumo"]);
  for (const s of d.secoes) {
    if (s.kpis?.length || s.texto?.length) {
      resumo.addRow([]);
      resumo.addRow([s.titulo]).font = { bold: true, size: 12 };
      for (const k of s.kpis ?? []) resumo.addRow([k.rotulo, k.valor, k.detalhe ?? ""]);
      for (const t of s.texto ?? []) resumo.addRow([t]);
    }
    if (s.tabela) {
      let nome = (s.tabela.aba ?? s.titulo).replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
      for (let i = 2; usadas.has(nome); i++) nome = `${nome.slice(0, 28)} ${i}`;
      usadas.add(nome);

      const aba = wb.addWorksheet(nome, { views: [{ state: "frozen", ySplit: 1 }] });
      aba.columns = s.tabela.colunas.map((c) => ({ header: c.titulo, width: Math.max(12, Math.min(48, (c.largura ?? 1) * 14)) }));
      const cab = aba.getRow(1);
      cab.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cab.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF216BD9" } };
      for (const linha of s.tabela.linhas) aba.addRow(linha.map((v) => (v === null ? "" : v)));
      aba.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.tabela.colunas.length } };
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV com ";" (padrão do Excel em pt-BR). Várias tabelas viram blocos com título. */
export function renderizarCsv(d: Documento): Buffer {
  const tabelas = d.secoes.filter((s) => s.tabela);
  const blocos: string[] = [];
  for (const s of tabelas) {
    const t = s.tabela!;
    const linhas = [t.colunas.map((c) => c.titulo), ...t.linhas];
    const corpo = linhas.map((l) => l.map(celulaCsv).join(";")).join("\r\n");
    blocos.push(tabelas.length > 1 ? `${celulaCsv(s.titulo)}\r\n${corpo}` : corpo);
  }
  if (blocos.length === 0) {
    blocos.push(d.secoes.flatMap((s) => [...(s.kpis ?? []).map((k) => `${celulaCsv(k.rotulo)};${celulaCsv(k.valor)}`), ...(s.texto ?? []).map(celulaCsv)]).join("\r\n"));
  }
  return Buffer.from("﻿" + blocos.join("\r\n\r\n"), "utf8");
}
