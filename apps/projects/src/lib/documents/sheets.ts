/**
 * Drawing-sheet metadata from a PDF page's text layer (CGC-60 / PLT-50): sheet number, title,
 * revision and discipline from the title block. Pure: the browser's pdf.js hands us the text
 * items (PDF user space, origin bottom-left) and this decides. Pages without a usable text
 * layer (scans) come back with source 'none' and a placeholder the reviewer replaces by hand.
 */

export interface TextItem {
  str: string;
  /** Baseline origin in PDF points, origin bottom-left. */
  x: number;
  y: number;
  /** Width / font height in points. */
  w: number;
  h: number;
}

export interface PageText {
  index: number;
  width: number;
  height: number;
  items: TextItem[];
}

export interface SheetGuess {
  index: number;
  sheetNumber: string;
  title: string | null;
  revision: string | null;
  discipline: string | null;
  confidence: number;
  source: 'text' | 'none';
}

/** A-101, A101, S2.01, FP-1, E-201A, M0.1, C-1.2, G001 */
const SHEET_RE = /^([A-Z]{1,3})[-.\s]?(\d{1,3}(?:\.\d{1,3})?[A-Z]?)$/;
const LABEL_RE = /^(SHEET|SHEET\s*(NO|NUMBER|#)\.?|DWG\.?\s*(NO\.?)?|DRAWING\s*(NO|NUMBER)\.?)\s*:?$/;
const REV_RE = /^REV(?:ISION)?\.?\s*(?:NO\.?\s*)?[:#]?\s*([A-Z0-9]{1,3})$/;
const NOISE_RE = /^(SHEET|SCALE|DATE|DRAWN|CHECKED|APPROVED|PROJECT|JOB|NO\.?|REV(ISION)?S?|ISSUE|ISSUED|FOR|BY|TITLE|SEAL|CLIENT|OWNER|ARCHITECT|ENGINEER|NORTH|KEY\s*PLAN|DESCRIPTION|MARK)\b/;

export const DISCIPLINES: Readonly<Record<string, string>> = {
  G: 'General', GI: 'General', T: 'Title', C: 'Civil', L: 'Landscape', S: 'Structural', A: 'Architectural',
  AD: 'Architectural demolition', ID: 'Interiors', I: 'Interiors', Q: 'Equipment', F: 'Fire protection', FP: 'Fire protection',
  P: 'Plumbing', D: 'Process', M: 'Mechanical', H: 'Mechanical', E: 'Electrical', EL: 'Electrical', ES: 'Electrical site',
  FA: 'Fire alarm', T1: 'Telecom', TC: 'Telecom', TN: 'Telecom', R: 'Resource', X: 'Other', V: 'Survey', B: 'Geotechnical',
  K: 'Kitchen', LS: 'Life safety', LV: 'Low voltage',
};

/** "a 101 " → "A-101" style normalization used for matching across sets (keeps the author's separator). */
export function normalizeSheetNumber(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > 40 ? s.slice(0, 40) : s;
}

export function disciplineOf(sheetNumber: string): string | null {
  const m = /^([A-Z]{1,3})/.exec(sheetNumber.toUpperCase());
  if (!m) return null;
  const pre = m[1];
  return DISCIPLINES[pre] ?? DISCIPLINES[pre.slice(0, 2)] ?? DISCIPLINES[pre.slice(0, 1)] ?? null;
}

/** Placeholder number for a page with no usable text ("SHEET-3"); the reviewer renames it. */
export function placeholderNumber(index: number): string {
  return `SHEET-${index + 1}`;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface Scored { item: TextItem; text: string; score: number }

function inTitleBlock(it: TextItem, page: PageText): number {
  const rx = it.x / Math.max(page.width, 1);
  const ry = it.y / Math.max(page.height, 1);
  // title blocks sit bottom-right (most US sets) or along the right edge
  let s = 0;
  if (rx > 0.6) s += 1;
  if (rx > 0.8) s += 1;
  if (ry < 0.3) s += 1;
  if (ry < 0.12) s += 1;
  return s;
}

/** Guess one page. */
export function guessSheet(page: PageText): SheetGuess {
  const items = page.items.map((i) => ({ ...i, str: clean(i.str) })).filter((i) => i.str.length > 0 && i.h > 0);
  if (items.length === 0) {
    return { index: page.index, sheetNumber: placeholderNumber(page.index), title: null, revision: null, discipline: null, confidence: 0, source: 'none' };
  }
  const maxH = Math.max(...items.map((i) => i.h));
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.str.toUpperCase(), (counts.get(i.str.toUpperCase()) ?? 0) + 1);
  const labels = items.filter((i) => LABEL_RE.test(i.str.toUpperCase()));

  const candidates: Scored[] = [];
  for (const it of items) {
    const text = it.str.toUpperCase();
    const m = SHEET_RE.exec(text);
    if (!m) continue;
    if (!DISCIPLINES[m[1]] && !DISCIPLINES[m[1].slice(0, 1)]) continue;
    let score = inTitleBlock(it, page);
    score += Math.min(3, (it.h / maxH) * 3);                                  // big type
    if ((counts.get(text) ?? 0) > 2) score -= 3;                               // repeated: grid or detail tags
    if (labels.some((l) => Math.abs(l.x - it.x) < page.width * 0.12 && it.y < l.y && l.y - it.y < it.h * 4 + 30)) score += 2;
    if (/^\d/.test(m[2])) score += 0.5;
    candidates.push({ item: it, text, score });
  }
  candidates.sort((a, b) => b.score - a.score || b.item.h - a.item.h || b.item.x - a.item.x);
  const best = candidates[0];
  if (!best || best.score < 2) {
    return { index: page.index, sheetNumber: placeholderNumber(page.index), title: null, revision: guessRevision(items), discipline: null, confidence: 0, source: 'none' };
  }
  const sheetNumber = normalizeSheetNumber(best.text) ?? placeholderNumber(page.index);
  const runnerUp = candidates[1]?.score ?? 0;
  const confidence = Math.max(0.3, Math.min(0.98, 0.45 + (best.score - runnerUp) * 0.08 + best.score * 0.04));
  return {
    index: page.index,
    sheetNumber,
    title: guessTitle(items, page, best.item),
    revision: guessRevision(items),
    discipline: disciplineOf(sheetNumber),
    confidence: Math.round(confidence * 1000) / 1000,
    source: 'text',
  };
}

function guessTitle(items: TextItem[], page: PageText, num: TextItem): string | null {
  const near = items.filter((i) => i !== num
    && inTitleBlock(i, page) >= 2
    && i.str.length >= 4 && i.str.length <= 80
    && /[A-Za-z]{3}/.test(i.str)
    && !NOISE_RE.test(i.str.toUpperCase())
    && !SHEET_RE.test(i.str.toUpperCase())
    && !/\d{3,}.*\d{3,}/.test(i.str)                 // phone numbers, addresses, project numbers
    && !/@|www\.|https?:/i.test(i.str)
    && Math.abs(i.x - num.x) < page.width * 0.3
    && i.y >= num.y - num.h * 2);
  if (near.length === 0) return null;
  // Prefer large type close above the number; join a second line of the same size directly below it.
  near.sort((a, b) => (b.h - a.h) || (Math.abs(a.y - num.y) - Math.abs(b.y - num.y)));
  const first = near[0];
  const second = near.find((i) => i !== first && Math.abs(i.h - first.h) < 0.5 && first.y - i.y > 0 && first.y - i.y < first.h * 1.8 && Math.abs(i.x - first.x) < page.width * 0.1);
  const title = clean(second ? `${first.str} ${second.str}` : first.str);
  return title.length ? title.slice(0, 200) : null;
}

function guessRevision(items: TextItem[]): string | null {
  for (const i of items) {
    const m = REV_RE.exec(i.str.toUpperCase());
    if (m && m[1] !== 'NO') return m[1];
  }
  return null;
}

/** Guess every page; when two pages land on the same number, the weaker one falls back to a placeholder. */
export function guessSheets(pages: ReadonlyArray<PageText>): SheetGuess[] {
  const out = pages.map(guessSheet);
  const seen = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const g = out[i];
    const prev = seen.get(g.sheetNumber);
    if (prev === undefined) { seen.set(g.sheetNumber, i); continue; }
    const loser = out[prev].confidence >= g.confidence ? i : prev;
    out[loser] = { ...out[loser], sheetNumber: placeholderNumber(out[loser].index), confidence: 0, source: 'none' };
    if (loser === prev) seen.set(g.sheetNumber, i);
  }
  return out;
}
