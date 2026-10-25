/**
 * A small flowing-layout writer on pdf-lib for branded business documents: header with logo and
 * company name, rules in the brand colour, wrapped text, key/value grids, ruled tables with
 * right-aligned figures, totals, notices, signature blocks (which record their anchors so the
 * e-sign stamp lands exactly there), and "page x of y" footers. Letter size, 0.6" margins.
 * Standard fonts (Helvetica) only: text is folded to WinAnsi so nothing throws on odd characters.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 43;

export interface Brand {
  companyName: string;
  primaryColor: string;
  inkColor: string;
  /** PNG or JPEG bytes of the logo (already fetched and validated), or null. */
  logo: Uint8Array | null;
  /** Extra header lines (address, licence, phone) — optional. */
  headerLines?: string[];
}

export interface SignatureAnchor {
  /** 1-based position of the signer the block belongs to (matched to esign_signers.position). */
  position: number;
  role: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function hexColor(hex: string, fallback: RGB = rgb(0.145, 0.388, 0.922)): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const REPLACE: Record<string, string> = {
  '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ',
  '‑': '-', '‐': '-', '✓': 'x', '✕': 'x', '×': 'x', '≈': '~', '≠': '!=',
};

/** Fold text to what the standard fonts can encode. */
export function winAnsi(font: PDFFont, s: string): string {
  let out = '';
  for (const ch of s.replace(/\r\n?/g, '\n')) {
    const r = REPLACE[ch] ?? ch;
    try {
      font.encodeText(r);
      out += r;
    } catch {
      out += '?';
    }
  }
  return out;
}

export class Writer {
  readonly doc: PDFDocument;
  readonly brand: Brand;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  anchors: SignatureAnchor[] = [];
  private logo: PDFImage | null = null;
  private primary: RGB;
  private ink: RGB;
  private muted = rgb(0.24, 0.31, 0.4);
  private line = rgb(0.85, 0.87, 0.9);
  private title = '';
  private subtitle = '';

  private constructor(doc: PDFDocument, brand: Brand) {
    this.doc = doc;
    this.brand = brand;
    this.primary = hexColor(brand.primaryColor);
    this.ink = hexColor(brand.inkColor, rgb(0.04, 0.09, 0.16));
  }

  static async create(brand: Brand, meta: { title: string; subtitle?: string; author?: string }): Promise<Writer> {
    const doc = await PDFDocument.create();
    const w = new Writer(doc, brand);
    w.font = await doc.embedFont(StandardFonts.Helvetica);
    w.bold = await doc.embedFont(StandardFonts.HelveticaBold);
    if (brand.logo && brand.logo.length > 8) {
      try {
        const b = brand.logo;
        w.logo = b[0] === 0x89 && b[1] === 0x50 ? await doc.embedPng(b) : b[0] === 0xff && b[1] === 0xd8 ? await doc.embedJpg(b) : null;
      } catch {
        w.logo = null;
      }
    }
    w.title = meta.title;
    w.subtitle = meta.subtitle ?? '';
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author ?? brand.companyName);
    doc.setCreator('Merit Projects');
    doc.setProducer('Merit Projects');
    w.newPage();
    return w;
  }

  t(s: string, bold = false): string {
    return winAnsi(bold ? this.bold : this.font, s);
  }

  width(s: string, size: number, bold = false): number {
    return (bold ? this.bold : this.font).widthOfTextAtSize(this.t(s, bold), size);
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pageNo += 1;
    const top = PAGE_H - MARGIN;
    let x = MARGIN;
    if (this.logo) {
      const h = 34;
      const w = Math.min(150, (this.logo.width / this.logo.height) * h);
      this.page.drawImage(this.logo, { x, y: top - h, width: w, height: h });
      x += w + 12;
    }
    this.page.drawText(this.t(this.brand.companyName, true), { x, y: top - 14, size: 12, font: this.bold, color: this.ink });
    (this.brand.headerLines ?? []).slice(0, 2).forEach((l, i) => {
      this.page.drawText(this.t(l), { x, y: top - 27 - i * 10, size: 8, font: this.font, color: this.muted });
    });
    const tw = this.width(this.title, 15, true);
    this.page.drawText(this.t(this.title, true), { x: PAGE_W - MARGIN - tw, y: top - 14, size: 15, font: this.bold, color: this.ink });
    if (this.subtitle) {
      const sw = this.width(this.subtitle, 9);
      this.page.drawText(this.t(this.subtitle), { x: PAGE_W - MARGIN - sw, y: top - 28, size: 9, font: this.font, color: this.muted });
    }
    this.page.drawRectangle({ x: MARGIN, y: top - 44, width: PAGE_W - 2 * MARGIN, height: 2, color: this.primary });
    this.y = top - 62;
  }

  /** Ensure `h` points of room; otherwise continue on a new page. */
  room(h: number): void {
    if (this.y - h < MARGIN + 24) this.newPage();
  }

  wrap(s: string, size: number, maxW: number, bold = false): string[] {
    const out: string[] = [];
    for (const para of this.t(s, bold).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (words.length === 0) { out.push(''); continue; }
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if ((bold ? this.bold : this.font).widthOfTextAtSize(next, size) <= maxW) { line = next; continue; }
        if (line) out.push(line);
        // break a single over-long word
        let rest = w;
        while ((bold ? this.bold : this.font).widthOfTextAtSize(rest, size) > maxW && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && (bold ? this.bold : this.font).widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      if (line) out.push(line);
    }
    return out;
  }

  heading(s: string): void {
    this.room(30);
    this.y -= 6;
    this.page.drawText(this.t(s.toUpperCase(), true), { x: MARGIN, y: this.y, size: 8.5, font: this.bold, color: this.primary });
    this.y -= 5;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.5, color: this.line });
    this.y -= 13;
  }

  text(s: string, opts: { size?: number; bold?: boolean; muted?: boolean; indent?: number } = {}): void {
    const size = opts.size ?? 9.5;
    const x = MARGIN + (opts.indent ?? 0);
    for (const l of this.wrap(s, size, PAGE_W - MARGIN - x, opts.bold)) {
      this.room(size + 4);
      this.page.drawText(l, { x, y: this.y, size, font: opts.bold ? this.bold : this.font, color: opts.muted ? this.muted : this.ink });
      this.y -= size + 3.5;
    }
    this.y -= 4;
  }

  /** Two columns of label / value pairs. */
  kv(rows: ReadonlyArray<readonly [string, string]>, cols = 2): void {
    const colW = (PAGE_W - 2 * MARGIN) / cols;
    for (let i = 0; i < rows.length; i += cols) {
      const chunk = rows.slice(i, i + cols);
      const heights = chunk.map(([, v]) => this.wrap(v || '-', 9.5, colW - 12).length);
      const h = 11 + Math.max(...heights) * 12.5;
      this.room(h + 4);
      chunk.forEach(([k, v], j) => {
        const x = MARGIN + j * colW;
        this.page.drawText(this.t(k.toUpperCase(), true), { x, y: this.y, size: 7, font: this.bold, color: this.muted });
        this.wrap(v || '-', 9.5, colW - 12).forEach((l, n) => {
          this.page.drawText(l, { x, y: this.y - 11 - n * 12.5, size: 9.5, font: this.font, color: this.ink });
        });
      });
      this.y -= h + 6;
    }
  }

  /** Ruled table; figures right-aligned. `widths` are fractions of the content width. */
  table(columns: ReadonlyArray<{ label: string; width: number; align?: 'left' | 'right' }>, rows: ReadonlyArray<ReadonlyArray<string>>, totals: ReadonlyArray<readonly [string, string, boolean?]> = []): void {
    const W = PAGE_W - 2 * MARGIN;
    const xs: number[] = [];
    let acc = MARGIN;
    for (const c of columns) { xs.push(acc); acc += c.width * W; }
    const head = () => {
      this.room(22);
      columns.forEach((c, i) => {
        const cw = c.width * W;
        const label = this.t(c.label.toUpperCase(), true);
        const lw = this.bold.widthOfTextAtSize(label, 7);
        this.page.drawText(label, { x: c.align === 'right' ? xs[i] + cw - lw - 4 : xs[i] + 4, y: this.y, size: 7, font: this.bold, color: this.muted });
      });
      this.y -= 6;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.8, color: this.ink });
      this.y -= 12;
    };
    head();
    for (const r of rows) {
      const cells = columns.map((c, i) => this.wrap(r[i] ?? '', 9, c.width * W - 8));
      const h = Math.max(...cells.map((c) => c.length)) * 11.5 + 4;
      if (this.y - h < MARGIN + 24) { this.newPage(); head(); }
      cells.forEach((lines, i) => {
        const c = columns[i];
        lines.forEach((l, n) => {
          const lw = this.font.widthOfTextAtSize(l, 9);
          this.page.drawText(l, { x: c.align === 'right' ? xs[i] + c.width * W - lw - 4 : xs[i] + 4, y: this.y - n * 11.5, size: 9, font: this.font, color: this.ink });
        });
      });
      this.y -= h;
      this.page.drawLine({ start: { x: MARGIN, y: this.y + 8 }, end: { x: PAGE_W - MARGIN, y: this.y + 8 }, thickness: 0.4, color: this.line });
    }
    if (totals.length) {
      this.y -= 2;
      for (const [label, value, strong] of totals) {
        this.room(16);
        const f = strong ? this.bold : this.font;
        const size = strong ? 10.5 : 9.5;
        const vw = f.widthOfTextAtSize(this.t(value, strong), size);
        const lw = f.widthOfTextAtSize(this.t(label, strong), size);
        this.page.drawText(this.t(label, strong), { x: PAGE_W - MARGIN - 130 - lw, y: this.y, size, font: f, color: this.ink });
        this.page.drawText(this.t(value, strong), { x: PAGE_W - MARGIN - 4 - vw, y: this.y, size, font: f, color: this.ink });
        if (strong) this.page.drawLine({ start: { x: PAGE_W - MARGIN - 240, y: this.y + size + 3 }, end: { x: PAGE_W - MARGIN, y: this.y + size + 3 }, thickness: 1.2, color: this.ink });
        this.y -= size + 6;
      }
    }
    this.y -= 8;
  }

  notice(title: string, body: string): void {
    const lines = this.wrap(body, 8.5, PAGE_W - 2 * MARGIN - 20);
    const h = 18 + lines.length * 11;
    this.room(h + 8);
    this.page.drawRectangle({ x: MARGIN, y: this.y - h + 10, width: PAGE_W - 2 * MARGIN, height: h, borderColor: this.ink, borderWidth: 0.8 });
    this.page.drawText(this.t(title.toUpperCase(), true), { x: MARGIN + 10, y: this.y - 2, size: 8, font: this.bold, color: this.ink });
    lines.forEach((l, i) => this.page.drawText(l, { x: MARGIN + 10, y: this.y - 15 - i * 11, size: 8.5, font: this.font, color: this.ink }));
    this.y -= h + 8;
  }

  /** Signature lines, two per row; each records an anchor for the e-sign stamp. */
  signatures(blocks: ReadonlyArray<{ position: number; role: string; name?: string | null }>): void {
    const colW = (PAGE_W - 2 * MARGIN - 24) / 2;
    for (let i = 0; i < blocks.length; i += 2) {
      this.room(78);
      blocks.slice(i, i + 2).forEach((b, j) => {
        const x = MARGIN + j * (colW + 24);
        const lineY = this.y - 40;
        this.anchors.push({ position: b.position, role: b.role, page: this.pageNo - 1, x, y: lineY + 2, width: colW * 0.72, height: 36 });
        this.page.drawLine({ start: { x, y: lineY }, end: { x: x + colW, y: lineY }, thickness: 0.8, color: this.ink });
        this.page.drawText(this.t(`${b.role}${b.name ? ` - ${b.name}` : ''}`, true), { x, y: lineY - 11, size: 8, font: this.bold, color: this.ink });
        this.page.drawText(this.t('Signature'), { x, y: lineY - 21, size: 7, font: this.font, color: this.muted });
        this.page.drawText(this.t('Date'), { x: x + colW * 0.76, y: lineY - 21, size: 7, font: this.font, color: this.muted });
      });
      this.y -= 82;
    }
  }

  spacer(h = 8): void {
    this.y -= h;
  }

  /** Footers on every page, then the bytes. */
  async finish(footer: string): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({ start: { x: MARGIN, y: MARGIN + 6 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 6 }, thickness: 0.4, color: this.line });
      p.drawText(this.t(footer), { x: MARGIN, y: MARGIN - 6, size: 7, font: this.font, color: this.muted });
      const pn = this.t(`Page ${i + 1} of ${pages.length}`);
      p.drawText(pn, { x: PAGE_W - MARGIN - this.font.widthOfTextAtSize(pn, 7), y: MARGIN - 6, size: 7, font: this.font, color: this.muted });
    });
    return this.doc.save({ useObjectStreams: true });
  }
}
