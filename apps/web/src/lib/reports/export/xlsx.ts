import { deflateRawSync } from 'zlib';
import { centsToDollars } from '@meritbooks/shared';
import type { StatementModel, StmtRow } from './statement-model';

/**
 * Zero-dependency OOXML (.xlsx) writer — StatementModel(s) → a genuine Excel
 * workbook a finance team can hand to auditors/board.
 *
 * Why hand-rolled and not a library: the repo installs NO spreadsheet dependency
 * (checked package.json — only @react-pdf/renderer for PDF), and CLAUDE.md's build
 * rules forbid adding a heavy dep without cause. An .xlsx file is just a ZIP of a
 * few XML parts, and Node ships `zlib` — so ~250 lines gives us a REAL spreadsheet
 * (true numeric money cells with an accounting number format, bold section/total
 * rows, frozen header, sized columns, one worksheet per report) with no new
 * dependency and no client-bundle weight (this module is server-only; routes import
 * it, the client never does).
 *
 * Money stays bigint CENTS through the StatementModel (CANON-ANCHOR §2 — never
 * floats) and is converted to display dollars ONLY at the cell edge via
 * centsToDollars, exactly like the CSV/PDF writers, so every figure ties out to the
 * on-screen report.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ZIP container (store one deflate-compressed entry per XML part)
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // compression method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); // compressed size
    local.writeUInt32LE(e.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0, 14); // date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────────
// XML helpers
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Strip control chars XML 1.0 forbids (keep tab/newline/carriage-return).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 1-based column index → spreadsheet letter (1→A, 27→AA). */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Cell-style indices — must match the <cellXfs> order in STYLES below.
const S = {
  default: 0,
  bold: 1,
  title: 2,
  meta: 3,
  headerText: 4,
  headerNum: 5,
  moneyNormal: 6,
  moneyBold: 7,
  moneyTotal: 8,
  labelBold: 9,
  labelTotal: 10,
} as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF10B981"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF94A3B8"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ─────────────────────────────────────────────────────────────────────────────
// Cell + row emitters
// ─────────────────────────────────────────────────────────────────────────────

function textCell(ref: string, value: string, style: number): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}
function numCell(ref: string, value: number, style: number): string {
  const v = Number.isFinite(value) ? value : 0;
  return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
}

function labelStyle(kind: StmtRow['kind']): number {
  switch (kind) {
    case 'section':
    case 'subtotal':
      return S.labelBold;
    case 'total':
      return S.labelTotal;
    case 'note':
      return S.meta;
    default:
      return S.default;
  }
}
function moneyStyle(kind: StmtRow['kind']): number {
  switch (kind) {
    case 'section':
    case 'subtotal':
      return S.moneyBold;
    case 'total':
      return S.moneyTotal;
    default:
      return S.moneyNormal;
  }
}

/** One worksheet XML part for a single statement. */
function sheetXml(model: StatementModel): string {
  const rowsXml: string[] = [];
  let r = 0;

  const emit = (cells: string) => {
    r += 1;
    rowsXml.push(`<row r="${r}">${cells}</row>`);
  };
  const emitBlank = () => {
    r += 1;
    rowsXml.push(`<row r="${r}"/>`);
  };

  // ── Metadata banner ──
  emit(textCell(`A${r + 1}`, model.title, S.title));
  if (model.entityLabel) emit(textCell(`A${r + 1}`, model.entityLabel, S.meta));
  if (model.periodLabel) emit(textCell(`A${r + 1}`, model.periodLabel, S.meta));
  if (model.basisLabel) emit(textCell(`A${r + 1}`, model.basisLabel, S.meta));
  emit(textCell(`A${r + 1}`, `Generated ${new Date(model.generatedAt).toLocaleString('en-US')}`, S.meta));
  emitBlank();

  // ── Header row ──
  const headerRow = r + 1;
  const headerCells: string[] = [
    textCell(`A${headerRow}`, 'Account #', S.headerText),
    textCell(`B${headerRow}`, 'Description', S.headerText),
  ];
  model.columns.forEach((col, i) => {
    const ref = `${colLetter(3 + i)}${headerRow}`;
    headerCells.push(textCell(ref, col.label, col.money ? S.headerNum : S.headerText));
  });
  emit(headerCells.join(''));

  // ── Data rows ──
  for (const row of model.rows) {
    if (row.kind === 'spacer') {
      emitBlank();
      continue;
    }
    const rr = r + 1;
    const cells: string[] = [];
    if (row.code) cells.push(textCell(`A${rr}`, row.code, row.kind === 'total' ? S.labelTotal : S.default));
    const indent = row.indent ? '  '.repeat(row.indent) : '';
    cells.push(textCell(`B${rr}`, `${indent}${row.label}`, labelStyle(row.kind)));

    model.columns.forEach((col, i) => {
      const v = row.values[i];
      if (v === null || v === undefined || v === '') return; // leave the cell empty
      const ref = `${colLetter(3 + i)}${rr}`;
      if (col.money && typeof v === 'number') {
        cells.push(numCell(ref, centsToDollars(v), moneyStyle(row.kind)));
      } else if (typeof v === 'number') {
        cells.push(numCell(ref, v, row.kind === 'total' || row.kind === 'subtotal' ? S.bold : S.default));
      } else {
        cells.push(textCell(ref, String(v), labelStyle(row.kind)));
      }
    });
    emit(cells.join(''));
  }

  const lastCol = colLetter(2 + Math.max(1, model.columns.length));
  const lastRow = Math.max(r, headerRow);
  const dataStart = headerRow + 1;

  const colCount = 2 + model.columns.length;
  const cols =
    `<cols>` +
    `<col min="1" max="1" width="14" customWidth="1"/>` +
    `<col min="2" max="2" width="42" customWidth="1"/>` +
    `<col min="3" max="${colCount}" width="16" customWidth="1"/>` +
    `</cols>`;

  const sheetViews =
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane xSplit="2" ySplit="${headerRow}" topLeftCell="C${dataStart}" activePane="bottomRight" state="frozen"/>` +
    `<selection pane="bottomRight" activeCell="C${dataStart}" sqref="C${dataStart}"/>` +
    `</sheetView></sheetViews>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    sheetViews +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    cols +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    `</worksheet>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Worksheet naming (Excel: ≤31 chars, no []:*?/\, unique)
// ─────────────────────────────────────────────────────────────────────────────

function sheetName(title: string, used: Set<string>): string {
  let base = (title || 'Sheet').replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n})`;
    base = base.slice(0, 31 - suffix.length);
    name = `${base}${suffix}`;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build a whole workbook from one or more StatementModels
// ─────────────────────────────────────────────────────────────────────────────

export function workbookFromModels(models: StatementModel[]): Buffer {
  const sheets = models.length ? models : [
    { title: 'Empty', entityLabel: '', periodLabel: '', generatedAt: new Date().toISOString(), columns: [{ key: 'v', label: 'Value' }], rows: [] } as StatementModel,
  ];

  const used = new Set<string>();
  const named = sheets.map((m) => ({ model: m, name: sheetName(m.title, used) }));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    named
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('') +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    named
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.model), 'utf8') })),
  ];

  return zip(entries);
}
