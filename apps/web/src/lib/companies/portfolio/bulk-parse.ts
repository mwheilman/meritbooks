/**
 * Bulk company list parsing — pure (no I/O; runs in the browser for the preview).
 *
 * Accepts what people actually have:
 *   - a pasted list, one company per line (commas inside a name are fine:
 *     "Acme Holdings, LLC" stays one company),
 *   - a CSV with a header row (name, optional industry, optional fiscal-year start),
 *   - rows pasted from Excel / Google Sheets (tab-separated), with or without a header.
 *
 * Fiscal-year start accepts 1–12, "Jan"/"January", or "FY starts July"-ish text
 * containing a month name.
 */

import { csvToGrid } from './tb-grid';
import { companyNameKey } from '../short-code';

export interface ParsedCompanyRow {
  name: string;
  industry: string | null;
  fiscalYearStartMonth: number | null;
  /** Optional explicit short code from a CSV "code" column. */
  shortCode: string | null;
}

export interface ParsedCompanyList {
  rows: ParsedCompanyRow[];
  warnings: string[];
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Parse a fiscal-year start month. Returns null for blank, NaN for unreadable. */
export function parseMonth(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? n : Number.NaN;
  }
  for (let i = 0; i < 12; i++) {
    const full = MONTH_NAMES[i];
    const re = new RegExp(`\\b(${full}|${full.slice(0, 3)}${full === 'september' ? '|sept' : ''})\\b`);
    if (re.test(s)) return i + 1;
  }
  return Number.NaN;
}

const isNameHeader = (h: string) => /^(company|company name|name|entity|entity name|legal name|business|client)$/i.test(h.trim());
const isIndustryHeader = (h: string) => /^(industry|sector|vertical|type)$/i.test(h.trim());
const isFyHeader = (h: string) => /(fiscal|fy|year start|year-end|year end|start month)/i.test(h.trim());
const isCodeHeader = (h: string) => /^(code|short code|shortcode|abbr|abbreviation)$/i.test(h.trim());

export function parseCompanyList(text: string): ParsedCompanyList {
  const warnings: string[] = [];
  const raw = (text ?? '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], warnings };

  const firstCells = lines[0].includes('\t') ? lines[0].split('\t') : csvToGrid(lines[0])[0] ?? [];
  const hasHeader = firstCells.some(isNameHeader);
  const tabbed = lines.some((l) => l.includes('\t'));

  let records: { name: string; industry: string; fy: string; code: string; line: number }[];
  if (hasHeader) {
    const grid = csvToGrid(raw).filter((r) => r.some((c) => c !== ''));
    const header = grid[0];
    const iName = header.findIndex(isNameHeader);
    const iInd = header.findIndex(isIndustryHeader);
    const iFy = header.findIndex(isFyHeader);
    const iCode = header.findIndex(isCodeHeader);
    records = grid.slice(1).map((r, idx) => ({
      name: r[iName] ?? '',
      industry: iInd >= 0 ? r[iInd] ?? '' : '',
      fy: iFy >= 0 ? r[iFy] ?? '' : '',
      code: iCode >= 0 ? r[iCode] ?? '' : '',
      line: idx + 2,
    }));
  } else if (tabbed) {
    // Pasted spreadsheet cells with no header: name, industry, fiscal-year start.
    records = lines.map((l, idx) => {
      const c = l.split('\t').map((x) => x.trim());
      return { name: c[0] ?? '', industry: c[1] ?? '', fy: c[2] ?? '', code: '', line: idx + 1 };
    });
  } else {
    // Plain list — the whole line is the name (commas included).
    records = lines.map((l, idx) => ({ name: l.replace(/^[-*•\d.)\s]+(?=\S)/, '').trim() || l, industry: '', fy: '', code: '', line: idx + 1 }));
  }

  const seen = new Set<string>();
  const rows: ParsedCompanyRow[] = [];
  for (const r of records) {
    const name = r.name.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = companyNameKey(name);
    if (seen.has(key)) { warnings.push(`Line ${r.line}: "${name}" is listed twice — kept once.`); continue; }
    seen.add(key);
    let fy = parseMonth(r.fy);
    if (fy !== null && Number.isNaN(fy)) {
      warnings.push(`Line ${r.line}: couldn't read fiscal-year start "${r.fy}" — using the default.`);
      fy = null;
    }
    rows.push({
      name: name.slice(0, 200),
      industry: r.industry.trim() ? r.industry.trim().slice(0, 100) : null,
      fiscalYearStartMonth: fy,
      shortCode: r.code.trim() ? r.code.trim().toUpperCase() : null,
    });
  }
  return { rows, warnings };
}
