/**
 * Dealer imports — column mapping + statement footing (pure, client-safe).
 *
 *  - `suggestMapping` proposes column → field from header names using each field's
 *    generic synonyms (exact header match beats "header contains the word").
 *  - `applyMapping` turns spreadsheet records into field-keyed `Cells`.
 *  - `detectHeaderRow` skips title rows ("Statement for …", "As of …") above the table.
 *  - `splitTotalsRow` lifts a trailing "Total" row out of the lines and offers it as the
 *    statement footer (a total row is never imported as a line).
 *  - `footLender` / `footOem` run D1's own footing rule so the screen and the server
 *    agree to the cent (AC11: a statement whose lines don't foot is rejected).
 */

import { normHeader, readCsvGrid, type Grid } from '@/lib/import/spreadsheet';
import { footStatement, type FootingResult } from '../engine/statement-match';
import type { ImportFileKind } from '../types';
import { KIND_FIELDS, type TargetField } from './fields';
import type { Cells, LenderLine, OemLine } from './targets';
import { centsToCell, parseMoneyCell } from './values';

/** field key → source column header (null = not mapped). */
export type ColumnMapping = Record<string, string | null>;

function scoreHeader(header: string, f: TargetField): number {
  const h = normHeader(header);
  if (!h) return 0;
  const syns = [f.label, f.key, ...f.synonyms].map(normHeader).filter(Boolean);
  if (syns.includes(h)) return 100;
  // Header contains a multi-character synonym as whole words ("Current Balance Due" ⊃ "current balance").
  let best = 0;
  for (const s of syns) {
    if (s.length < 3) continue;
    const re = new RegExp(`(^|\\s)${s.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}(\\s|$)`);
    if (re.test(h)) best = Math.max(best, 40 + Math.min(s.length, 30));
  }
  return best;
}

/**
 * Suggest a mapping. Each column is used at most once; the strongest (header, field)
 * pairs win first, so "Serial #" goes to the serial field and not to a loose match.
 */
export function suggestMapping(kind: ImportFileKind, headers: string[]): ColumnMapping {
  const fields = KIND_FIELDS[kind];
  const pairs: Array<{ key: string; header: string; score: number; order: number }> = [];
  fields.forEach((f, fi) => {
    headers.forEach((h) => {
      const s = scoreHeader(h, f);
      if (s > 0) pairs.push({ key: f.key, header: h, score: s, order: fi });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.order - b.order);
  const out: ColumnMapping = Object.fromEntries(fields.map((f) => [f.key, null]));
  const usedHeaders = new Set<string>();
  for (const p of pairs) {
    if (out[p.key] !== null || usedHeaders.has(p.header)) continue;
    out[p.key] = p.header;
    usedHeaders.add(p.header);
  }
  return out;
}

/** Keep only mappings to headers that exist (a saved profile may name an old column). */
export function reconcileMapping(kind: ImportFileKind, headers: string[], saved: ColumnMapping): ColumnMapping {
  const set = new Set(headers);
  const out: ColumnMapping = Object.fromEntries(KIND_FIELDS[kind].map((f) => [f.key, null]));
  for (const f of KIND_FIELDS[kind]) {
    const h = saved[f.key];
    if (h && set.has(h)) out[f.key] = h;
  }
  return out;
}

/** Required fields that have no column (and no default can fill). */
export function unmappedRequired(kind: ImportFileKind, mapping: ColumnMapping): TargetField[] {
  return KIND_FIELDS[kind].filter((f) => f.required && !mapping[f.key]);
}

export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): Cells[] {
  const entries = Object.entries(mapping).filter((e): e is [string, string] => !!e[1]);
  return rows.map((row) => {
    const cells: Cells = {};
    for (const [key, header] of entries) cells[key] = (row[header] ?? '').trim();
    return cells;
  });
}

/**
 * Find the header row: the row (within the first 40) whose cells match the most field
 * synonyms; ties go to the earliest. Falls back to the first non-empty row.
 */
export function detectHeaderRow(grid: Grid, kind: ImportFileKind): number {
  const fields = KIND_FIELDS[kind];
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(grid.length, 40);
  for (let i = 0; i < limit; i++) {
    const row = grid[i] ?? [];
    const nonEmpty = row.filter((c) => c.trim() !== '');
    if (nonEmpty.length < 2) continue;
    // A header row is mostly text, not amounts.
    const numeric = nonEmpty.filter((c) => /^[-($]?[\d,.]+\)?$/.test(c.trim())).length;
    if (numeric > nonEmpty.length / 2) continue;
    let hits = 0;
    for (const c of nonEmpty) if (fields.some((f) => scoreHeader(c, f) >= 50)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      best = i;
    }
  }
  if (best >= 0 && bestScore >= 2) return best;
  const first = grid.findIndex((r) => (r ?? []).some((c) => c.trim() !== ''));
  return first < 0 ? 0 : first;
}

const TOTAL_RE = /^(grand\s+)?totals?\b|^sub\s*totals?\b|^statement total|^total balance/i;

/** True when a mapped row is a totals line (some cell starts "Total…" and no id is present). */
export function isTotalsRow(kind: ImportFileKind, raw: Record<string, string>, cells: Cells): boolean {
  const idKeys = kind === 'OEM_STATEMENT' ? ['reference', 'serialNumber'] : ['lenderInvoiceNumber', 'serialNumber'];
  const anyTotal = Object.values(raw).some((v) => TOTAL_RE.test((v ?? '').trim()));
  if (!anyTotal) return false;
  return idKeys.every((k) => !cells[k] || TOTAL_RE.test(cells[k]));
}

export interface FooterSuggestion {
  footerPrincipal?: string;
  footerInterest?: string;
  footerFees?: string;
  footerTotal?: string;
}

/**
 * Separate statement lines from a totals row. Returns the remaining lines (with their
 * original indexes) and the footer the totals row states, as editable dollar text.
 */
export function splitTotalsRow(
  kind: ImportFileKind,
  raws: Record<string, string>[],
  cells: Cells[],
): { keep: number[]; dropped: number[]; footer: FooterSuggestion } {
  const keep: number[] = [];
  const dropped: number[] = [];
  let footer: FooterSuggestion = {};
  cells.forEach((c, i) => {
    if (isTotalsRow(kind, raws[i] ?? {}, c)) {
      dropped.push(i);
      const money = (k: string): string | undefined => {
        const p = parseMoneyCell(c[k], { allowNegative: kind === 'OEM_STATEMENT' });
        return p.ok && p.value !== null ? centsToCell(p.value) : undefined;
      };
      footer =
        kind === 'OEM_STATEMENT'
          ? { footerTotal: money('amountCents') }
          : { footerPrincipal: money('currentCents'), footerInterest: money('interestCents'), footerFees: money('feesCents') };
    } else keep.push(i);
  });
  return { keep, dropped, footer };
}

/** D1's footing rule over typed lender lines. */
export function footLender(
  lines: LenderLine[],
  footer: { principalCents: number | null; interestCents?: number | null; feesCents?: number | null; lineCount?: number | null },
): FootingResult {
  return footStatement(
    lines.map((l) => ({
      lender_invoice_number: l.lenderInvoiceNumber ?? null,
      serial_number: l.serialNumber ?? null,
      model: l.model ?? null,
      original_cents: l.originalCents ?? null,
      current_cents: l.currentCents ?? null,
      interest_cents: l.interestCents ?? null,
      fees_cents: l.feesCents ?? null,
      lender_code: l.lenderCode ?? null,
    })),
    { principalCents: footer.principalCents, interestCents: footer.interestCents ?? null, feesCents: footer.feesCents ?? null, lineCount: footer.lineCount ?? null },
  );
}

export interface OemFooting {
  ok: boolean;
  sumCents: number;
  footerTotalCents: number | null;
  differenceCents: number | null;
}

/** OEM statements: signed lines must sum to the statement total (D1 rule). */
export function footOem(lines: OemLine[], footerTotalCents: number | null): OemFooting {
  const sumCents = lines.reduce((s, l) => s + l.amountCents, 0);
  if (footerTotalCents === null) return { ok: false, sumCents, footerTotalCents, differenceCents: null };
  return { ok: sumCents === footerTotalCents, sumCents, footerTotalCents, differenceCents: sumCents - footerTotalCents };
}

/**
 * Pasted text (an email body) → grid. Tab-separated when most lines have tabs (a table
 * copied from an email or spreadsheet), else CSV, else runs of 2+ spaces (fixed-width).
 */
export function textToGrid(text: string): Grid {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return [];
  const tabbed = nonEmpty.filter((l) => l.includes('\t')).length;
  if (tabbed >= nonEmpty.length / 2) return lines.map((l) => (l.trim() === '' ? [] : l.split('\t').map((c) => c.trim())));
  const commas = nonEmpty.filter((l) => (l.match(/,/g) ?? []).length >= 2).length;
  if (commas >= nonEmpty.length / 2) return readCsvGrid(text);
  return lines.map((l) => (l.trim() === '' ? [] : l.trim().split(/\s{2,}/).map((c) => c.trim())));
}

/** A grid looks like a table when 3+ rows have 3+ cells. */
export function looksTabular(grid: Grid): boolean {
  return grid.filter((r) => r.filter((c) => c !== '').length >= 3).length >= 3;
}

/** Of several sheets, the one whose detected header row matches the most fields. */
export function pickSheet(kind: ImportFileKind, sheets: Array<{ name: string; grid: Grid }>): number {
  let best = 0;
  let bestHits = -1;
  sheets.forEach((s, i) => {
    const h = detectHeaderRow(s.grid, kind);
    const row = s.grid[h] ?? [];
    const hits = row.filter((c) => KIND_FIELDS[kind].some((f) => scoreHeader(c, f) >= 50)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  });
  return best;
}

/** Header names and up to N sample values per column (for the mapping preview). */
export function sampleColumns(headers: string[], rows: Record<string, string>[], n = 3): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of headers) {
    out[h] = rows.map((r) => r[h] ?? '').filter((v) => v !== '').slice(0, n);
  }
  return out;
}
