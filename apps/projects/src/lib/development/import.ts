/**
 * Development migration and pro forma import (RED-08 / RED-44): spreadsheets exported from Excel
 * (or an ARGUS budget export saved as CSV) → the rows pm.dev_stage_import takes. The database
 * suggests the cost code / lender line / CIP map; a person confirms it before anything is written.
 *   BUDGET / PRO_FORMA  {name, code, category, amount_cents}
 *   DRAWS               {draw_number, period_end, requested_cents, approved_cents, funded_cents, funded_on}
 *   WAIVERS             {vendor_name, doc_type, status, covers_through, amount_cents}
 * Pure; unit-tested.
 */
import { dateText, dollarsToCentsText, headerIndex, numText, parseDelimited } from '@/lib/dealer/tabular';

export const DEV_IMPORT_KINDS = ['PRO_FORMA', 'BUDGET', 'DRAWS', 'WAIVERS'] as const;
export type DevImportKind = (typeof DEV_IMPORT_KINDS)[number];

export const DEV_CATEGORIES = ['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER'] as const;
export type DevCategory = (typeof DEV_CATEGORIES)[number];

export interface DevImportParse {
  kind: DevImportKind;
  rows: Array<Record<string, string | number | null>>;
  issues: Array<{ row: number; message: string }>;
  totalCents: number;
}

/** "Hard costs", "Construction" → HARD; "Interest reserve" → INTEREST_RESERVE … (OTHER when unknown). */
export function categoryOf(text: string | null | undefined): DevCategory {
  const s = (text ?? '').toLowerCase();
  if (/land|acquisition|site purchase/.test(s)) return 'LAND';
  if (/interest reserve|capitalized interest/.test(s)) return 'INTEREST_RESERVE';
  if (/contingenc/.test(s)) return 'CONTINGENCY';
  if (/developer fee|dev fee|development fee/.test(s)) return 'DEVELOPER_FEE';
  if (/loan fee|financing|lender|closing cost|points/.test(s)) return 'FINANCING';
  if (/hard|construction|gmp|sitework|building/.test(s)) return 'HARD';
  if (/soft|architect|engineering|legal|permit|consult|design|insurance|marketing/.test(s)) return 'SOFT';
  return 'OTHER';
}

const BUDGET: Readonly<Record<'name' | 'code' | 'category' | 'amount', readonly string[]>> = {
  name: ['line item', 'description', 'name', 'budget line', 'item', 'line'],
  code: ['code', 'cost code', 'account', 'gl'],
  category: ['category', 'type', 'group', 'section'],
  amount: ['amount', 'budget', 'total', 'original budget', 'current budget', 'cost'],
};
const DRAWS: Readonly<Record<'no' | 'period' | 'requested' | 'approved' | 'funded' | 'fundedOn', readonly string[]>> = {
  no: ['draw', 'draw #', 'draw number', 'application', 'application no', 'pay app'],
  period: ['period', 'period end', 'period to', 'through'],
  requested: ['requested', 'amount requested', 'current payment due'],
  approved: ['approved', 'amount approved'],
  funded: ['funded', 'amount funded', 'wire amount'],
  fundedOn: ['funded on', 'funding date', 'date funded', 'wire date'],
};
const WAIVERS: Readonly<Record<'vendor' | 'type' | 'status' | 'through' | 'amount', readonly string[]>> = {
  vendor: ['vendor', 'subcontractor', 'contractor', 'payee'],
  type: ['type', 'waiver type', 'doc type'],
  status: ['status', 'received'],
  through: ['through', 'through date', 'covers through', 'period'],
  amount: ['amount', 'waiver amount'],
};

function waiverType(s: string): string {
  const t = s.toLowerCase();
  if (/final/.test(t)) return 'LIEN_WAIVER_FINAL';
  if (/uncond/.test(t)) return 'LIEN_WAIVER_UNCONDITIONAL';
  if (/cond/.test(t)) return 'LIEN_WAIVER_CONDITIONAL';
  return 'LIEN_WAIVER_UNCONDITIONAL';
}

export function parseDevImport(kind: DevImportKind, text: string): DevImportParse {
  const grid = parseDelimited(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim() !== ''));
  const issues: DevImportParse['issues'] = [];
  const rows: DevImportParse['rows'] = [];
  let total = 0;
  if (kind === 'BUDGET' || kind === 'PRO_FORMA') {
    const h = grid.findIndex((r) => { const ix = headerIndex(r, BUDGET); return ix.name >= 0 && ix.amount >= 0; });
    if (h < 0) return { kind, rows, issues: [{ row: 1, message: 'Need a line-item and an amount column' }], totalCents: 0 };
    const ix = headerIndex(grid[h]!, BUDGET);
    let section: string | null = null;
    for (let i = h + 1; i < grid.length; i++) {
      const r = grid[i]!;
      const name = (r[ix.name] ?? '').trim();
      const amount = dollarsToCentsText(r[ix.amount]);
      if (!name) continue;
      if (amount == null) { section = name; continue; }            // a section header row ("Hard costs")
      if (/^(sub)?total/i.test(name)) continue;
      if (amount < 0) { issues.push({ row: i + 1, message: `${name}: negative amount` }); continue; }
      const cat = ix.category >= 0 && r[ix.category]?.trim() ? categoryOf(r[ix.category]) : categoryOf(`${name} ${section ?? ''}`);
      rows.push({ name: name.slice(0, 200), code: ix.code >= 0 ? (r[ix.code] ?? '').trim() || null : null, category: cat, amount_cents: amount });
      total += amount;
    }
  } else if (kind === 'DRAWS') {
    const h = grid.findIndex((r) => headerIndex(r, DRAWS).no >= 0);
    if (h < 0) return { kind, rows, issues: [{ row: 1, message: 'Need a draw number column' }], totalCents: 0 };
    const ix = headerIndex(grid[h]!, DRAWS);
    for (let i = h + 1; i < grid.length; i++) {
      const r = grid[i]!;
      const no = numText(r[ix.no]);
      if (no == null || no < 1 || !Number.isInteger(no)) { if ((r[ix.no] ?? '').trim()) issues.push({ row: i + 1, message: `Draw "${r[ix.no]}" is not a number` }); continue; }
      const approved = ix.approved >= 0 ? dollarsToCentsText(r[ix.approved]) : null;
      const funded = ix.funded >= 0 ? dollarsToCentsText(r[ix.funded]) : null;
      rows.push({ draw_number: no, period_end: ix.period >= 0 ? dateText(r[ix.period]) : null, requested_cents: ix.requested >= 0 ? dollarsToCentsText(r[ix.requested]) : null,
        approved_cents: approved ?? funded, funded_cents: funded ?? approved, funded_on: ix.fundedOn >= 0 ? dateText(r[ix.fundedOn]) : null });
      total += funded ?? approved ?? 0;
    }
  } else {
    const h = grid.findIndex((r) => headerIndex(r, WAIVERS).vendor >= 0);
    if (h < 0) return { kind, rows, issues: [{ row: 1, message: 'Need a vendor column' }], totalCents: 0 };
    const ix = headerIndex(grid[h]!, WAIVERS);
    for (let i = h + 1; i < grid.length; i++) {
      const r = grid[i]!;
      const vendor = (r[ix.vendor] ?? '').trim();
      if (!vendor) continue;
      const st = ix.status >= 0 ? (r[ix.status] ?? '').trim().toLowerCase() : 'received';
      rows.push({ vendor_name: vendor, doc_type: waiverType(ix.type >= 0 ? r[ix.type] ?? '' : ''),
        status: /^(y|yes|received|on file|true|x)$/.test(st) ? 'RECEIVED' : /verified/.test(st) ? 'VERIFIED' : 'MISSING',
        covers_through: ix.through >= 0 ? dateText(r[ix.through]) : null, amount_cents: ix.amount >= 0 ? dollarsToCentsText(r[ix.amount]) : null });
    }
  }
  return { kind, rows, issues, totalCents: total };
}
