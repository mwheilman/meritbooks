/**
 * Balance-sheet earnings roll-in — every balance sheet presents the earnings that
 * have NOT yet been closed to retained earnings, so A = L + E holds before the
 * year-end close (audit L5: board package "Off by $488.00", entity snapshot "Out
 * of balance by $488.00", equity $0).
 *
 * A balance sheet built from ASSET/LIABILITY/EQUITY lines alone omits every P&L
 * line, so until the year-end CLOSING entry (migration 038 — dated the last day
 * of the fiscal year, it zeroes the P&L into retained earnings) posts, assets
 * exceed L + booked E by exactly the cumulative net income. The standard
 * presentation adds two equity lines:
 *
 *   • "Retained earnings — prior years (not yet closed)"  Σ P&L before FY start
 *     (0 once each prior year has been closed — the closing entry nets it out)
 *   • "Net income (current year)"                          Σ P&L FY start → as-of
 *
 * Earnings (natural, credit-positive) = Σ (credit − debit) over REVENUE / COGS /
 * OPEX / OTHER lines. Fiscal year start comes from the company
 * (core.locations.fiscal_year_start_month) when ONE company is in scope, else the
 * org (core.organizations.fiscal_year_start_month).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { fiscalYearStartFor, normalizeFyStartMonth } from '@/lib/dates/org-date';

export const PNL_ACCOUNT_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;

export const SYNTHETIC_PRIOR_RE_ID = 'synthetic:retained-earnings-unclosed';
export const SYNTHETIC_CY_NI_ID = 'synthetic:net-income-current-year';
export const EARNINGS_SUBTYPE_NAME = 'Retained Earnings';
export const EARNINGS_GROUP_NAME = 'Earnings not yet closed';
export const PRIOR_RE_LABEL = 'Retained earnings — prior years (not yet closed)';
export const CY_NI_LABEL = 'Net income (current year)';

// ─────────────────────────────────────────────────────────────────────────────
// Pure core
// ─────────────────────────────────────────────────────────────────────────────

export interface PnlLine {
  entryDate: string;
  debitCents: number;
  creditCents: number;
}

export interface UnclosedEarnings {
  fiscalYearStart: string;
  /** Σ P&L before the fiscal-year start (credit-positive). */
  priorYearsCents: number;
  /** Σ P&L from fiscal-year start through as-of (credit-positive) — current-year NI. */
  currentYearCents: number;
}

export function splitUnclosedEarnings(
  lines: readonly PnlLine[],
  opts: { asOfDate: string; fiscalYearStart: string },
): UnclosedEarnings {
  let prior = 0;
  let current = 0;
  for (const l of lines) {
    if (l.entryDate > opts.asOfDate) continue;
    const natural = Math.round(l.creditCents) - Math.round(l.debitCents);
    if (l.entryDate < opts.fiscalYearStart) prior += natural;
    else current += natural;
  }
  return { fiscalYearStart: opts.fiscalYearStart, priorYearsCents: prior, currentYearCents: current };
}

/** Structural balance-sheet payload (the report route + board package shape). */
export interface BsAccountLike {
  accountId?: string;
  accountNumber: string;
  accountName: string;
  balanceCents: number;
  groupName?: string;
  synthetic?: boolean;
}
export interface BsGroupLike {
  name: string;
  accounts: BsAccountLike[];
  totalCents: number;
}
export interface BsSubTypeLike {
  name: string;
  groups: BsGroupLike[];
  totalCents: number;
}
export interface BsSectionLike {
  type: string;
  label: string;
  subTypes: BsSubTypeLike[];
  totalCents: number;
}
export interface BsSummaryLike {
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  liabilitiesPlusEquityCents: number;
  isBalanced: boolean;
  varianceCents: number;
  currentYearNetIncomeCents?: number;
  priorYearsUnclosedEarningsCents?: number;
  fiscalYearStart?: string;
}
export interface BsPayloadLike {
  sections: BsSectionLike[];
  summary: BsSummaryLike;
}

/**
 * Return a copy of `bs` with the unclosed-earnings lines added to EQUITY and every
 * total + the balance check recomputed. The prior-years line is omitted when 0;
 * the current-year line is always shown (a standard balance-sheet line).
 */
export function applyEarningsToBalanceSheet<T extends BsPayloadLike>(bs: T, earnings: UnclosedEarnings): T {
  const lines: BsAccountLike[] = [];
  if (earnings.priorYearsCents !== 0) {
    lines.push({
      accountId: SYNTHETIC_PRIOR_RE_ID,
      accountNumber: '',
      accountName: PRIOR_RE_LABEL,
      balanceCents: earnings.priorYearsCents,
      groupName: EARNINGS_GROUP_NAME,
      synthetic: true,
    });
  }
  lines.push({
    accountId: SYNTHETIC_CY_NI_ID,
    accountNumber: '',
    accountName: CY_NI_LABEL,
    balanceCents: earnings.currentYearCents,
    groupName: EARNINGS_GROUP_NAME,
    synthetic: true,
  });
  const addCents = earnings.priorYearsCents + earnings.currentYearCents;
  const group: BsGroupLike = { name: EARNINGS_GROUP_NAME, accounts: lines, totalCents: addCents };

  let sections = bs.sections.map((s) => s);
  const eqIdx = sections.findIndex((s) => s.type === 'EQUITY');
  if (eqIdx >= 0) {
    const eq = sections[eqIdx];
    sections[eqIdx] = {
      ...eq,
      subTypes: [...eq.subTypes, { name: EARNINGS_SUBTYPE_NAME, groups: [group], totalCents: addCents }],
      totalCents: eq.totalCents + addCents,
    };
  } else {
    sections = [
      ...sections,
      { type: 'EQUITY', label: 'Equity', subTypes: [{ name: EARNINGS_SUBTYPE_NAME, groups: [group], totalCents: addCents }], totalCents: addCents },
    ];
  }

  const assets = sections.find((s) => s.type === 'ASSET')?.totalCents ?? 0;
  const liabilities = sections.find((s) => s.type === 'LIABILITY')?.totalCents ?? 0;
  const equity = sections.find((s) => s.type === 'EQUITY')?.totalCents ?? 0;
  const variance = assets - (liabilities + equity);
  return {
    ...bs,
    sections,
    summary: {
      ...bs.summary,
      totalAssetsCents: assets,
      totalLiabilitiesCents: liabilities,
      totalEquityCents: equity,
      liabilitiesPlusEquityCents: liabilities + equity,
      isBalanced: variance === 0,
      varianceCents: variance,
      currentYearNetIncomeCents: earnings.currentYearCents,
      priorYearsUnclosedEarningsCents: earnings.priorYearsCents,
      fiscalYearStart: earnings.fiscalYearStart,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O (RLS-scoped)
// ─────────────────────────────────────────────────────────────────────────────

/** Fiscal-year start month: the company's when ONE is in scope, else the org's. */
export async function resolveFyStartMonth(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  locationIds: readonly string[],
): Promise<number> {
  if (locationIds.length === 1) {
    const { data } = await supabase
      .schema('core')
      .from('locations')
      .select('fiscal_year_start_month')
      .eq('id', locationIds[0])
      .limit(1);
    const m = (data?.[0] as { fiscal_year_start_month?: number | null } | undefined)?.fiscal_year_start_month;
    if (m != null) return normalizeFyStartMonth(m);
  }
  let q = supabase.schema('core').from('organizations').select('fiscal_year_start_month').limit(1);
  if (orgId) q = q.eq('id', orgId);
  const { data } = await q;
  return normalizeFyStartMonth((data?.[0] as { fiscal_year_start_month?: number | null } | undefined)?.fiscal_year_start_month);
}

interface PnlLineRow {
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  gl_entries: { entry_date: string } | null;
}

/** Load POSTED P&L lines through `asOfDate` (line-level company scope) and split them. */
export async function fetchUnclosedEarnings(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  opts: { asOfDate: string; locationIds: readonly string[]; fyStartMonth?: number | null },
): Promise<UnclosedEarnings> {
  const fyStartMonth = opts.fyStartMonth ?? (await resolveFyStartMonth(supabase, orgId, opts.locationIds));
  const fiscalYearStart = fiscalYearStartFor(opts.asOfDate, fyStartMonth);
  const locs = opts.locationIds;
  const { data, error } = await fetchAll(
    () => {
      let q = supabase
        .from('gl_entry_lines')
        .select('id, debit_cents, credit_cents, accounts!inner(account_type), gl_entries!inner(entry_date, status)')
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', opts.asOfDate)
        .in('accounts.account_type', [...PNL_ACCOUNT_TYPES]);
      if (locs.length === 1) q = q.eq('location_id', locs[0]);
      else if (locs.length > 1) q = q.in('location_id', [...locs]);
      return q;
    },
    { label: 'bs-earnings P&L gl_entry_lines' },
  );
  if (error) throw new Error(error.message);
  const lines: PnlLine[] = ((data ?? []) as unknown as PnlLineRow[]).map((r) => ({
    entryDate: r.gl_entries?.entry_date ?? '9999-12-31',
    debitCents: Number(r.debit_cents ?? 0),
    creditCents: Number(r.credit_cents ?? 0),
  }));
  return splitUnclosedEarnings(lines, { asOfDate: opts.asOfDate, fiscalYearStart });
}
