/**
 * ChartTable → .xlsx, in the BROWSER (and in Node for tests).
 *
 * lib/reports/export/xlsx.ts is server-only (it deflates with node:zlib) and is
 * keyed to StatementModel, so a chart's Excel button can't reuse it without a
 * round trip. A workbook is a ZIP of six small XML parts; with the ZIP "store"
 * method (no compression) the whole writer is pure TypeScript over Uint8Array —
 * no dependency, no zlib, works in any browser. Chart tables are tiny, so the
 * missing compression costs nothing.
 *
 * Cells: money → numeric DOLLARS (cents ÷ 100 at the cell edge) with an
 * accounting format; percent → numeric fraction with 0.0%; gaps → empty cells.
 */
import type { ChartTable } from './table';

// ─────────────────────────────────────────────────────────── ZIP (store)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Minimal ZIP writer (method 0 = stored). */
export function zipStore(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Fixed DOS timestamp (1980-01-01) — deterministic output, testable.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, f.data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + size;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const all = [...chunks, ...central, end];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────── OOXML parts

function xmlEsc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Style indexes in styles.xml cellXfs. */
const S = { text: 0, head: 1, money: 2, pct: 3, num: 4, title: 5, note: 6, moneyBold: 7, textBold: 8 } as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="#,##0.##"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF2563EB"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF536A82"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FF2563EB"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(t: ChartTable, meta: string[]): string {
  const rows: string[] = [];
  let r = 0;
  const strCell = (ref: string, s: string, style: number) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
  const numCell = (ref: string, n: number, style: number) => `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
  const push = (cells: string[]) => {
    r += 1;
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  };
  push([strCell(`A${r + 1}`, t.caption, S.title)]);
  for (const m of meta) push([strCell(`A${r + 1}`, m, S.note)]);
  push([]);
  const headRow = r + 1;
  push(t.columns.map((c, j) => strCell(`${colName(j)}${r + 1}`, c.unit === 'money' ? `${c.label} ($)` : c.label, S.head)));
  for (const row of t.rows) {
    const bold = row.emphasis === 'total' || row.emphasis === 'subtotal';
    push(
      row.cells
        .map((cell, j) => {
          const ref = `${colName(j)}${r + 1}`;
          const col = t.columns[j];
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'string') return strCell(ref, cell, bold ? S.textBold : S.text);
          if (!Number.isFinite(cell)) return '';
          if (col?.unit === 'money') return numCell(ref, Math.round(cell) / 100, bold ? S.moneyBold : S.money);
          if (col?.unit === 'percent') return numCell(ref, Number(cell.toFixed(6)), S.pct);
          return numCell(ref, Number(cell.toFixed(6)), S.num);
        })
        .filter(Boolean),
    );
  }
  for (const n of t.notes ?? []) push([strCell(`A${r + 1}`, n, S.note)]);
  const widths = t.columns.map((c, j) => {
    const longest = Math.max(c.label.length + 4, ...t.rows.map((row) => (typeof row.cells[j] === 'string' ? (row.cells[j] as string).length : 12)));
    return `<col min="${j + 1}" max="${j + 1}" width="${Math.min(48, Math.max(12, longest + 2))}" customWidth="1"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

/** Excel sheet names: ≤31 chars, none of []:*?/\ */
export function sheetName(s: string): string {
  return (s.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Chart').slice(0, 31);
}

/** Build the workbook bytes for one ChartTable. */
export function chartTableToXlsx(t: ChartTable, meta: string[] = []): Uint8Array<ArrayBuffer> {
  const name = sheetName(t.caption);
  const files: Array<{ name: string; xml: string }> = [
    {
      name: '[Content_Types].xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', xml: STYLES },
    { name: 'xl/worksheets/sheet1.xml', xml: sheetXml(t, meta) },
  ];
  return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.xml) })));
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
