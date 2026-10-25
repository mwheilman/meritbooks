import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readJpegExif, exifDateToIso } from '@/lib/documents/exif';
import { guessSheet, guessSheets, disciplineOf, placeholderNumber, type PageText } from '@/lib/documents/sheets';
import { splitPdf, pdfPages, sha256Hex } from '@/lib/documents/pdf';
import { DOC_KINDS, RETENTION_CLASSES, SET_KINDS, MARKUP_KINDS, MarkupInput, kindMoneyCap, parseGeometry } from '@/lib/documents/types';
import { generateToken, hashToken, isTokenShape, signingLink } from '@/lib/esign/token';

// ------------------------------------------------------------------ EXIF fixture (little-endian TIFF)
function jpegWithExif(): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => { tiff.push(v & 255, (v >> 8) & 255); };
  const u32 = (v: number) => { tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); };
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  // layout: header(8) IFD0 @8 (3 entries) → exif IFD, gps IFD, data
  const ifd0At = 8; const ifd0Len = 2 + 3 * 12 + 4;
  const exifAt = ifd0At + ifd0Len; const exifLen = 2 + 2 * 12 + 4;
  const gpsAt = exifAt + exifLen; const gpsLen = 2 + 4 * 12 + 4;
  let dataAt = gpsAt + gpsLen;
  const make = ascii('Apple'); const makeAt = dataAt; dataAt += make.length;
  const dto = ascii('2026:10:01 09:03:00'); const dtoAt = dataAt; dataAt += dto.length;
  const off = ascii('-05:00'); const offAt = dataAt; dataAt += off.length;
  const latAt = dataAt; dataAt += 24; const lngAt = dataAt; dataAt += 24;
  tiff.push(0x49, 0x49); u16(42); u32(ifd0At);
  u16(3);
  u16(0x010f); u16(2); u32(make.length); u32(makeAt);
  u16(0x8769); u16(4); u32(1); u32(exifAt);
  u16(0x8825); u16(4); u32(1); u32(gpsAt);
  u32(0);
  u16(2);
  u16(0x9003); u16(2); u32(dto.length); u32(dtoAt);
  u16(0x9011); u16(2); u32(off.length); u32(offAt);
  u32(0);
  u16(4);
  u16(1); u16(2); u32(2); tiff.push(0x4e, 0, 0, 0);            // 'N'
  u16(2); u16(5); u32(3); u32(latAt);
  u16(3); u16(2); u32(2); tiff.push(0x57, 0, 0, 0);            // 'W'
  u16(4); u16(5); u32(3); u32(lngAt);
  u32(0);
  tiff.push(...make, ...dto, ...off);
  for (const [n, d] of [[41, 1], [35, 1], [1260, 100]]) { u32(n); u32(d); }   // 41° 35' 12.6"
  for (const [n, d] of [[93, 1], [37, 1], [3000, 100]]) { u32(n); u32(d); }   // 93° 37' 30"
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 255, len & 255, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

describe('photo EXIF', () => {
  it('reads capture time with its offset, GPS (signed, 6 places) and make', () => {
    const e = readJpegExif(jpegWithExif());
    expect(e.takenAt).toBe('2026-10-01T09:03:00-05:00');
    expect(e.takenAtRaw).toBe('2026:10:01 09:03:00');
    expect(e.gpsLat).toBeCloseTo(41.5868333, 5);
    expect(e.gpsLng).toBeCloseTo(-93.625, 5);
    expect(e.make).toBe('Apple');
  });
  it('without an offset, uses the uploader\'s time zone; garbage never throws', () => {
    expect(exifDateToIso('2026:10:01 09:03:00', null, 300)).toBe('2026-10-01T09:03:00-05:00');
    expect(exifDateToIso('not a date', null)).toBeNull();
    expect(readJpegExif(Uint8Array.from([1, 2, 3]))).toMatchObject({ takenAt: null, gpsLat: null });
    expect(readJpegExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0]))).toMatchObject({ takenAt: null });
  });
});

// ------------------------------------------------------------------ sheet extraction
const W = 2592; const H = 1728;   // 36 × 24 in
function page(index: number, items: Array<[string, number, number, number]>): PageText {
  return { index, width: W, height: H, items: items.map(([str, x, y, h]) => ({ str, x, y, h, w: str.length * h * 0.5 })) };
}

describe('sheet number / title from the text layer', () => {
  it('finds the title-block number, title, revision and discipline', () => {
    const g = guessSheet(page(0, [
      ['FIRST FLOOR PLAN', 2250, 190, 18], ['SHEET NO.', 2300, 140, 7], ['A-101', 2310, 90, 30], ['REV 2', 2450, 60, 8],
      ['A-101', 400, 900, 6], ['NORTH', 200, 200, 10], ['PROJECT NO. 2026-114', 2250, 300, 8], ['3/8" = 1\'-0"', 600, 120, 8],
    ]));
    expect(g).toMatchObject({ sheetNumber: 'A-101', title: 'FIRST FLOOR PLAN', revision: '2', discipline: 'Architectural', source: 'text' });
    expect(g.confidence).toBeGreaterThan(0.5);
  });
  it('a scanned page (no text) gets a placeholder for manual entry', () => {
    expect(guessSheet(page(4, []))).toMatchObject({ sheetNumber: 'SHEET-5', source: 'none', confidence: 0 });
    expect(placeholderNumber(0)).toBe('SHEET-1');
  });
  it('grid bubbles and repeated detail tags do not win; duplicates fall back to placeholders', () => {
    const grid = guessSheet(page(1, [['A1', 100, 1600, 12], ['A1', 900, 1600, 12], ['A1', 1600, 1600, 12], ['S-201', 2300, 80, 26], ['FOUNDATION PLAN', 2250, 170, 16]]));
    expect(grid.sheetNumber).toBe('S-201');
    expect(grid.discipline).toBe('Structural');
    const both = guessSheets([page(0, [['M-201', 2300, 80, 26]]), page(1, [['M-201', 2300, 80, 20]])]);
    expect(both.map((b) => b.sheetNumber)).toEqual(['M-201', 'SHEET-2']);
  });
  it('disciplines by prefix', () => {
    expect(disciplineOf('E-201A')).toBe('Electrical');
    expect(disciplineOf('FP-1')).toBe('Fire protection');
    expect(disciplineOf('ZZ-1')).toBeNull();
  });
});

// ------------------------------------------------------------------ split
async function makePdf(sizes: Array<[number, number]>): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => { const p = d.addPage([w, h]); p.drawText(`Sheet ${i + 1}`, { x: 40, y: 40, size: 24, font: f }); });
  return d.save();
}

describe('drawing set split', () => {
  it('one single-page PDF per page, sizes kept, each with its own hash', async () => {
    const set = await makePdf([[W, H], [W, H], [1224, 792]]);
    expect(await pdfPages(set)).toEqual([{ index: 0, width: W, height: H }, { index: 1, width: W, height: H }, { index: 2, width: 1224, height: 792 }]);
    const parts = await splitPdf(set, { title: 'IFC 1' });
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      const one = await PDFDocument.load(p.bytes);
      expect(one.getPageCount()).toBe(1);
      expect(p.sha256).toBe(sha256Hex(p.bytes));
    }
    expect(parts[2]).toMatchObject({ width: 1224, height: 792 });
    expect(new Set(parts.map((p) => p.sha256)).size).toBe(3);
  });
  it('refuses empty and oversized sets', async () => {
    await expect(splitPdf(await makePdf([[100, 100], [100, 100]]), { maxPages: 1 })).rejects.toThrow(/at most 1/);
  });
});

// ------------------------------------------------------------------ vocab parity with the migration
describe('closed lists match migration 1115', () => {
  const sql = readFileSync(resolve(__dirname, '../../../../packages/supabase/migrations/1115_pm_documents_esign.sql'), 'utf8');
  const list = (re: RegExp): string[] => {
    const m = re.exec(sql);
    if (!m) throw new Error(`not found: ${re}`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  it('kinds, retention classes, set kinds, markup kinds', () => {
    expect(list(/kind\s+text not null default 'file' check \(kind in \(([\s\S]*?)\)\)/)).toEqual([...DOC_KINDS]);
    expect(list(/retention_class in \(([^)]*)\)/)).toEqual([...RETENTION_CLASSES]);
    expect(list(/set_kind in \(([^)]*)\)/)).toEqual([...SET_KINDS]);
    expect(list(/kind\s+text not null check \(kind in \(('pin'[^)]*)\)\)/)).toEqual([...MARKUP_KINDS]);
  });
  it('money caps per kind', () => {
    expect(kindMoneyCap('contract')).toBe('projects.contract_value');
    expect(kindMoneyCap('lien_waiver')).toBe('projects.financials');
    expect(kindMoneyCap('photo')).toBeNull();
  });
});

describe('markup input', () => {
  it('validates geometry per kind (normalized 0…1) and requires text for notes', () => {
    expect(MarkupInput.safeParse({ kind: 'rect', geometry: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } }).success).toBe(true);
    expect(MarkupInput.safeParse({ kind: 'rect', geometry: { x: 1.4, y: 0.1, w: 0.2, h: 0.3 } }).success).toBe(false);
    expect(MarkupInput.safeParse({ kind: 'text', geometry: { x: 0.5, y: 0.5 } }).success).toBe(false);
    expect(MarkupInput.safeParse({ kind: 'freehand', geometry: { points: [[0.1, 0.1], [0.2, 0.25]] } }).success).toBe(true);
    expect(parseGeometry('pin', { x: 0.2, y: 0.9, extra: 1 })).toEqual({ x: 0.2, y: 0.9 });
  });
});

describe('signing tokens', () => {
  it('256-bit URL-safe tokens; only the hash is stored; links point at /sign', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isTokenShape(t)).toBe(true);
    expect(isTokenShape('short')).toBe(false);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(signingLink('https://projects.example.com/', t)).toBe(`https://projects.example.com/sign/${t}`);
  });
});
