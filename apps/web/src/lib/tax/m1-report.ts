/**
 * Schedule M-1 report assembler (RLS-scoped I/O around the pure engine).
 *
 * Computes BOOK net income exactly the way the income-statement route does (REVENUE −
 * COGS − OPEX − OTHER, each normal-balance-adjusted, POSTED only, over a date range), then
 * resolves the tagged book-tax differences from real GL activity and hands them to the pure
 * `computeM1` for the reconciliation. The engine never sees the database; this file never
 * does the arithmetic — a clean seam. RLS enforces org isolation (org_id is never
 * hand-filtered); the assembler never throws user-facing internals.
 *
 * Difference resolution:
 *   - ACCOUNT tag → the account's period activity (natural positive magnitude) × the line's
 *     disallowance %, EXCLUDING any lines that carry their own override (no double count).
 *   - LINE override → an explicit pinned amount, else that line's activity × the effective %.
 * Book net income is computed from ALL activity; overrides only change the tax adjustment.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeM1,
  resolveAccountDifferenceCents,
  type DifferenceType,
  type TaxableEffect,
  type TaggedDifference,
  type M1Reconciliation,
} from './book-tax';

export interface M1ReportOptions {
  startDate: string;
  endDate: string;
  locationIds?: string[];
}

interface AccountTagRow {
  account_id: string;
  m_line_code: string;
  difference_type: DifferenceType;
  taxable_effect: TaxableEffect;
  disallowance_pct: number | null;
  note: string | null;
}

interface LineOverrideRow {
  gl_entry_line_id: string;
  m_line_code: string;
  difference_type: DifferenceType;
  taxable_effect: TaxableEffect;
  disallowance_pct: number | null;
  override_amount_cents: number | null;
  note: string | null;
}

export interface M1Report extends M1Reconciliation {
  startDate: string;
  endDate: string;
  locationIds: string[];
  /** number of P&L accounts that carry a book-tax tag. */
  taggedAccountCount: number;
  /** number of accounts with book activity but NO tag (the AI's proposal candidates). */
  untaggedAccountCount: number;
}

/** Natural positive magnitude of a line for its account (expense/income size). */
function naturalActivity(debit: number, credit: number, normalBalance: string): number {
  return normalBalance === 'CREDIT' ? credit - debit : debit - credit;
}

interface AccountAccum {
  accountType: string;
  normalBalance: string;
  totalDebits: number;
  totalCredits: number;
  overriddenDebits: number;
  overriddenCredits: number;
}

export async function buildM1Report(
  supabase: SupabaseClient,
  opts: M1ReportOptions,
): Promise<M1Report> {
  const { startDate, endDate } = opts;
  const locationIds = opts.locationIds ?? [];

  // ── 1. P&L lines (same shape as the income-statement route) ──────────────────
  let query = supabase
    .from('gl_entry_lines')
    .select(`
      id,
      account_id,
      debit_cents,
      credit_cents,
      location_id,
      accounts!inner(
        account_number,
        name,
        account_type,
        account_groups!inner(
          account_sub_types!inner(
            account_types!inner(
              normal_balance
            )
          )
        )
      ),
      gl_entries!inner(entry_date, status)
    `)
    .eq('gl_entries.status', 'POSTED')
    .gte('gl_entries.entry_date', startDate)
    .lte('gl_entries.entry_date', endDate)
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);

  const { data: lines, error } = await query;
  if (error) throw new Error(error.message);
  const plLines = (lines ?? []) as unknown as Array<{
    id: string;
    account_id: string;
    debit_cents: number | null;
    credit_cents: number | null;
    accounts: {
      account_number: string;
      name: string;
      account_type: string;
      account_groups: { account_sub_types: { account_types: { normal_balance: string } } };
    };
  }>;

  // ── 2. Tags + overrides (RLS-scoped) ─────────────────────────────────────────
  const [{ data: tagRows }, { data: overrideRows }] = await Promise.all([
    supabase
      .from('book_tax_account_tags')
      .select('account_id, m_line_code, difference_type, taxable_effect, disallowance_pct, note'),
    supabase
      .from('book_tax_line_overrides')
      .select('gl_entry_line_id, m_line_code, difference_type, taxable_effect, disallowance_pct, override_amount_cents, note'),
  ]);
  const tags = (tagRows ?? []) as AccountTagRow[];
  const overrides = (overrideRows ?? []) as LineOverrideRow[];
  const tagByAccount = new Map(tags.map((t) => [t.account_id, t]));
  const overrideByLine = new Map(overrides.map((o) => [o.gl_entry_line_id, o]));

  // ── 3. Accumulate per account (full + overridden portions) ───────────────────
  const accts = new Map<string, AccountAccum>();
  const lineMeta = new Map<string, { accountId: string; normalBalance: string; debit: number; credit: number }>();

  for (const line of plLines) {
    const acctType = line.accounts.account_type;
    const normalBalance = line.accounts.account_groups.account_sub_types.account_types.normal_balance;
    const debit = Number(line.debit_cents ?? 0);
    const credit = Number(line.credit_cents ?? 0);
    lineMeta.set(line.id, { accountId: line.account_id, normalBalance, debit, credit });

    let a = accts.get(line.account_id);
    if (!a) {
      a = { accountType: acctType, normalBalance, totalDebits: 0, totalCredits: 0, overriddenDebits: 0, overriddenCredits: 0 };
      accts.set(line.account_id, a);
    }
    a.totalDebits += debit;
    a.totalCredits += credit;
    if (overrideByLine.has(line.id)) {
      a.overriddenDebits += debit;
      a.overriddenCredits += credit;
    }
  }

  // ── 4. Book net income from ALL activity (income-statement parity) ────────────
  const sectionTotals: Record<string, number> = { REVENUE: 0, COGS: 0, OPEX: 0, OTHER: 0 };
  for (const a of accts.values()) {
    const amount = a.normalBalance === 'CREDIT' ? a.totalCredits - a.totalDebits : a.totalDebits - a.totalCredits;
    sectionTotals[a.accountType] = (sectionTotals[a.accountType] ?? 0) + amount;
  }
  const bookNetIncomeCents =
    sectionTotals.REVENUE - sectionTotals.COGS - sectionTotals.OPEX - sectionTotals.OTHER;

  // ── 5. Resolve differences ───────────────────────────────────────────────────
  const differences: TaggedDifference[] = [];

  // 5a. account-level tags (excluding overridden lines' activity)
  let taggedAccountCount = 0;
  for (const [accountId, a] of accts.entries()) {
    const tag = tagByAccount.get(accountId);
    if (!tag) continue;
    taggedAccountCount += 1;
    const eligibleDebits = a.totalDebits - a.overriddenDebits;
    const eligibleCredits = a.totalCredits - a.overriddenCredits;
    const activity = naturalActivity(eligibleDebits, eligibleCredits, a.normalBalance);
    const amountCents = resolveAccountDifferenceCents(activity, tag.m_line_code, tag.disallowance_pct);
    if (amountCents === 0) continue;
    differences.push({
      code: tag.m_line_code,
      label: '',
      differenceType: tag.difference_type,
      taxableEffect: tag.taxable_effect,
      amountCents,
      source: 'account',
    });
  }

  // 5b. line overrides (explicit pinned amount, else derived from the line's activity)
  for (const o of overrides) {
    const meta = lineMeta.get(o.gl_entry_line_id);
    if (!meta) continue; // override references a line outside this period/scope — skip
    let amountCents: number;
    if (o.override_amount_cents != null) {
      amountCents = Math.abs(Number(o.override_amount_cents));
    } else {
      const activity = naturalActivity(meta.debit, meta.credit, meta.normalBalance);
      amountCents = resolveAccountDifferenceCents(activity, o.m_line_code, o.disallowance_pct);
    }
    if (amountCents === 0) continue;
    differences.push({
      code: o.m_line_code,
      label: '',
      differenceType: o.difference_type,
      taxableEffect: o.taxable_effect,
      amountCents,
      source: 'override',
    });
  }

  const reconciliation = computeM1(bookNetIncomeCents, differences);

  return {
    ...reconciliation,
    startDate,
    endDate,
    locationIds: locationIds.length > 0 ? locationIds : ['all'],
    taggedAccountCount,
    untaggedAccountCount: accts.size - taggedAccountCount,
  };
}
