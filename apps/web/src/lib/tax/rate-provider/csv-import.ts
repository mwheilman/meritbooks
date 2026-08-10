/**
 * PURE, zero-dependency CSV parsing + validation for bulk sales-tax rate import.
 *
 * Accepts a CSV with the header columns (case/space-insensitive, order-free):
 *   state, county, city, postal, rate, effective_date   (+ optional: category, end_date)
 * and produces normalized, validated rate rows the import route inserts with
 * source='IMPORT'. Deterministic and unit-testable; no I/O, no model calls.
 *
 * A quoted-field aware line splitter handles commas inside "quoted, values". Rows that
 * fail validation are returned as line-numbered errors rather than silently dropped, so
 * the reviewer sees exactly what didn't import.
 */

import { normalizeState } from '@/lib/controls/sales-tax-nexus';

export interface ParsedRateRow {
  state: string;
  county: string | null;
  city: string | null;
  postal_code: string | null;
  category: string | null;
  combined_rate_pct: number;
  effective_date: string;
  end_date: string | null;
}

export interface RateImportError {
  line: number;
  message: string;
}

export interface ParseRateCsvResult {
  rows: ParsedRateRow[];
  errors: RateImportError[];
  /** header names as detected (for the UI to echo the mapping). */
  headers: string[];
}

/** Split one CSV line into fields, honouring double-quoted values with embedded commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const canon = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Map a canonicalized header to our field key (tolerant of common aliases). */
function fieldFor(header: string): keyof ParsedRateRow | null {
  switch (canon(header)) {
    case 'state': case 'st': return 'state';
    case 'county': return 'county';
    case 'city': return 'city';
    case 'postal': case 'postalcode': case 'zip': case 'zipcode': return 'postal_code';
    case 'category': case 'taxcategory': case 'class': return 'category';
    case 'rate': case 'ratepct': case 'combinedrate': case 'combinedratepct': return 'combined_rate_pct';
    case 'effectivedate': case 'effective': case 'effdate': return 'effective_date';
    case 'enddate': case 'end': case 'expiry': return 'end_date';
    default: return null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse + validate CSV text into rate rows. Header row required. `state`, `rate`, and
 * `effective_date` are mandatory per row; county/city/postal/category/end_date optional.
 */
export function parseRateCsv(text: string): ParseRateCsvResult {
  const rows: ParsedRateRow[] = [];
  const errors: RateImportError[] = [];
  const lines = (text ?? '').split(/\r\n|\r|\n/).filter((l, i) => l.trim().length > 0 || i > 0);
  // Drop trailing empties.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return { rows, errors: [{ line: 0, message: 'File is empty.' }], headers: [] };

  const headerCells = splitCsvLine(lines[0]);
  const headerMap: (keyof ParsedRateRow | null)[] = headerCells.map(fieldFor);
  if (!headerMap.includes('state') || !headerMap.includes('combined_rate_pct') || !headerMap.includes('effective_date')) {
    return {
      rows,
      errors: [{ line: 1, message: 'Header must include state, rate, and effective_date columns.' }],
      headers: headerCells,
    };
  }

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const cells = splitCsvLine(raw);
    const rec: Partial<Record<keyof ParsedRateRow, string>> = {};
    headerMap.forEach((key, idx) => { if (key) rec[key] = (cells[idx] ?? '').trim(); });

    const lineNo = i + 1;
    const state = normalizeState(rec.state ?? null);
    if (!state) { errors.push({ line: lineNo, message: `Unrecognized state "${rec.state ?? ''}".` }); continue; }

    const rateNum = Number(String(rec.combined_rate_pct ?? '').replace(/[%\s]/g, ''));
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 30) {
      errors.push({ line: lineNo, message: `Invalid rate "${rec.combined_rate_pct ?? ''}" (expected 0–30%).` });
      continue;
    }

    const eff = (rec.effective_date ?? '').trim();
    if (!DATE_RE.test(eff)) { errors.push({ line: lineNo, message: `Invalid effective_date "${eff}" (expected YYYY-MM-DD).` }); continue; }

    const end = (rec.end_date ?? '').trim();
    if (end && !DATE_RE.test(end)) { errors.push({ line: lineNo, message: `Invalid end_date "${end}" (expected YYYY-MM-DD).` }); continue; }

    rows.push({
      state,
      county: rec.county?.trim() || null,
      city: rec.city?.trim() || null,
      postal_code: rec.postal_code?.trim() || null,
      category: rec.category?.trim() || null,
      combined_rate_pct: rateNum,
      effective_date: eff,
      end_date: end || null,
    });
  }

  return { rows, errors, headers: headerCells };
}

/** Build a display jurisdiction label from a parsed row (postal > city > county > state). */
export function labelForRow(r: ParsedRateRow): string {
  return [r.postal_code, r.city, r.county ? `${r.county} County` : null, r.state].filter(Boolean).join(', ');
}
