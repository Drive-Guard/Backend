/**
 * Renderiza o documento em PDF com pdf-lib (sem navegador, cabe na Lambda).
 *
 * As fontes padrão do PDF (Helvetica) só codificam WinAnsi: acentos do
 * português passam, mas setas e símbolos não. textoPdf troca o que dá e tira
 * o resto, para nenhum caractere derrubar a geração.
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { Documento, Secao, Tabela } from "./documento";

const A4: [number, number] = [595.28, 841.89];
const MARGEM = 40;
const COR_TEXTO = rgb(0.08, 0.09, 0.12);
const COR_SUAVE = rgb(0.42, 0.45, 0.5);
const COR_PRIMARIA = rgb(0.13, 0.42, 0.85);
const COR_LINHA = rgb(0.88, 0.9, 0.93);
const COR_ZEBRA = rgb(0.96, 0.97, 0.98);

const TROCAS: Record<string, string> = {
  "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "×": "x", "✓": "ok", "−": "-", " ": " ", " ": " ",
};
const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

export function textoPdf(s: string): string {
  let r = "";
  for (const ch of s) {
    if (TROCAS[ch] !== undefined) r += TROCAS[ch];
    else {
      const c = ch.codePointAt(0)!;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) r += ch;
      else if (ch === "\n" || ch === "\t") r += " ";
    }
  }
  return r;
}

class Escritor {
  pagina!: PDFPage;
  y = 0;
  numero = 0;

  constructor(
    private doc: PDFDocument,
    private fonte: PDFFont,
    private negrito: PDFFont,
    private rodape: string,
  ) {
    this.novaPagina();
  }

  get largura() {
    return A4[0] - 2 * MARGEM;
  }

  novaPagina() {
    this.pagina = this.doc.addPage(A4);
    this.numero += 1;
    this.y = A4[1] - MARGEM;
    this.pagina.drawText(textoPdf(`${this.rodape}  •  página ${this.numero}`), {
      x: MARGEM, y: 22, size: 8, font: this.fonte, color: COR_SUAVE,
    });
  }

  garantir(altura: number) {
    if (this.y - altura < MARGEM + 10) this.novaPagina();
  }

  quebrar(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
    const palavras = textoPdf(texto).split(/\s+/).filter(Boolean);
    const linhas: string[] = [];
    let atual = "";
    for (const p of palavras) {
      const teste = atual ? `${atual} ${p}` : p;
      if (fonte.widthOfTextAtSize(teste, tamanho) <= largura) atual = teste;
      else {
        if (atual) linhas.push(atual);
        atual = p;
      }
    }
    if (atual) linhas.push(atual);
    return linhas.length ? linhas : [""];
  }

  texto(t: string, { tamanho = 10, fonte = this.fonte, cor = COR_TEXTO, x = MARGEM, largura = this.largura, entre = 3 } = {}) {
    for (const linha of this.quebrar(t, fonte, tamanho, largura)) {
      this.garantir(tamanho + entre);
      this.y -= tamanho;
      this.pagina.drawText(linha, { x, y: this.y, size: tamanho, font: fonte, color: cor });
      this.y -= entre;
    }
  }

  cortar(t: string, fonte: PDFFont, tamanho: number, largura: number): string {
    let s = textoPdf(t);
    if (fonte.widthOfTextAtSize(s, tamanho) <= largura) return s;
    while (s.length > 1 && fonte.widthOfTextAtSize(`${s}…`, tamanho) > largura) s = s.slice(0, -1);
    return `${s}…`;
  }

  cabecalho(d: Documento) {
    this.pagina.drawRectangle({ x: 0, y: A4[1] - 6, width: A4[0], height: 6, color: COR_PRIMARIA });
    this.y -= 4;
    this.texto("DriveGuard", { tamanho: 10, fonte: this.negrito, cor: COR_PRIMARIA });
    this.texto(d.titulo, { tamanho: 20, fonte: this.negrito, entre: 6 });
    this.texto(`${d.empresa}  •  ${d.subtitulo}`, { tamanho: 9, cor: COR_SUAVE, entre: 14 });
  }

  secao(s: Secao) {
    this.garantir(40);
    this.y -= 6;
    this.texto(s.titulo, { tamanho: 13, fonte: this.negrito, entre: 4 });
    this.pagina.drawLine({ start: { x: MARGEM, y: this.y }, end: { x: A4[0] - MARGEM, y: this.y }, thickness: 0.6, color: COR_LINHA });
    this.y -= 8;
    if (s.kpis?.length) this.kpis(s.kpis);
    for (const p of s.texto ?? []) this.texto(`• ${p}`, { tamanho: 10, entre: 4 });
    if (s.tabela) this.tabela(s.tabela);
    this.y -= 6;
  }

  kpis(kpis: NonNullable<Secao["kpis"]>) {
    const porLinha = 4;
    const gap = 8;
    const w = (this.largura - gap * (porLinha - 1)) / porLinha;
    const h = 48;
    for (let i = 0; i < kpis.length; i += porLinha) {
      this.garantir(h + gap);
      const topo = this.y;
      kpis.slice(i, i + porLinha).forEach((k, j) => {
        const x = MARGEM + j * (w + gap);
        this.pagina.drawRectangle({ x, y: topo - h, width: w, height: h, borderColor: COR_LINHA, borderWidth: 0.8, color: COR_ZEBRA });
        this.pagina.drawText(this.cortar(k.rotulo.toUpperCase(), this.fonte, 7, w - 12), { x: x + 6, y: topo - 13, size: 7, font: this.fonte, color: COR_SUAVE });
        this.pagina.drawText(this.cortar(k.valor, this.negrito, 14, w - 12), { x: x + 6, y: topo - 31, size: 14, font: this.negrito, color: COR_TEXTO });
        if (k.detalhe) this.pagina.drawText(this.cortar(k.detalhe, this.fonte, 7, w - 12), { x: x + 6, y: topo - 42, size: 7, font: this.fonte, color: COR_SUAVE });
      });
      this.y = topo - h - gap;
    }
  }

  tabela(t: Tabela) {
    const tamanho = 8;
    const alturaLinha = 14;
    const pesos = t.colunas.map((c) => c.largura ?? 1);
    const soma = pesos.reduce((a, b) => a + b, 0);
    const larguras = pesos.map((p) => (p / soma) * this.largura);

    const desenharCabecalho = () => {
      this.garantir(alturaLinha * 2);
      this.pagina.drawRectangle({ x: MARGEM, y: this.y - alturaLinha, width: this.largura, height: alturaLinha, color: COR_PRIMARIA });
      let x = MARGEM;
      t.colunas.forEach((c, i) => {
        this.pagina.drawText(this.cortar(c.titulo, this.negrito, tamanho, larguras[i] - 6), {
          x: x + 3, y: this.y - alturaLinha + 4, size: tamanho, font: this.negrito, color: rgb(1, 1, 1),
        });
        x += larguras[i];
      });
      this.y -= alturaLinha;
    };

    desenharCabecalho();
    if (t.linhas.length === 0) {
      this.texto("Sem dados no período.", { tamanho: 9, cor: COR_SUAVE });
      return;
    }
    t.linhas.forEach((linha, n) => {
      if (this.y - alturaLinha < MARGEM + 10) {
        this.novaPagina();
        desenharCabecalho();
      }
      if (n % 2 === 1) this.pagina.drawRectangle({ x: MARGEM, y: this.y - alturaLinha, width: this.largura, height: alturaLinha, color: COR_ZEBRA });
      let x = MARGEM;
      linha.forEach((v, i) => {
        const texto = this.cortar(v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("pt-BR") : String(v), this.fonte, tamanho, larguras[i] - 6);
        const largura = this.fonte.widthOfTextAtSize(texto, tamanho);
        const xTexto = t.colunas[i].numero ? x + larguras[i] - 3 - largura : x + 3;
        this.pagina.drawText(texto, { x: xTexto, y: this.y - alturaLinha + 4, size: tamanho, font: this.fonte, color: COR_TEXTO });
        x += larguras[i];
      });
      this.y -= alturaLinha;
    });
    this.y -= 4;
  }
}

export async function renderizarPdf(d: Documento): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(textoPdf(d.titulo));
  doc.setAuthor("DriveGuard");
  doc.setCreationDate(d.geradoEm);
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const quando = d.geradoEm.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const e = new Escritor(doc, fonte, negrito, `DriveGuard • ${d.titulo} • gerado em ${quando}`);
  e.cabecalho(d);
  for (const s of d.secoes) e.secao(s);
  return Buffer.from(await doc.save());
}
