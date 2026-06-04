/**
 * Year-end close (Session 22) — roll temporary accounts into retained earnings.
 *
 * Per entity (core.locations), at fiscal year-end every P&L account (REVENUE,
 * COGS, OPEX, OTHER) is zeroed and its net balance moved to Retained Earnings
 * (role RETAINED_EARNINGS / 3020) via a single entry_type='CLOSING' journal
 * entry dated the last day of the year. Prior CLOSING entries are excluded from
 * the year's aggregation, so preview/run always reflect operational activity.
 *
 *   net(account) = Σdebit − Σcredit over POSTED, non-CLOSING lines in the year
 *     net < 0 (revenue, credit-normal)  -> DR |net|   (zero it)
 *     net > 0 (expense, debit-normal)   -> CR  net    (zero it)
 *   offset: CR Retained Earnings (net income)  /  DR Retained Earnings (net loss)
 *
 * Idempotent (one active close per entity-year), auditable, reversible.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, voidJournalEntry, type JournalEntryLineInput } from './gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

const PL_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

export interface CloseAccountLine {
  accountId: string;
  accountNumber: string;
  name: string;
  accountType: string;
  balanceCents: number;   // net = Σdebit − Σcredit (signed)
  debitCents: number;     // closing-entry debit on this account
  creditCents: number;    // closing-entry credit on this account
}

export interface CloseComputation {
  fiscalYear: number;
  closeDate: string;
  locationId: string;
  accounts: CloseAccountLine[];
  revenueCents: number;     // total income (positive)
  expenseCents: number;     // total expense (positive)
  netIncomeCents: number;   // revenue − expense
  retainedEarningsAccountId: string;
  lines: JournalEntryLineInput[];
  isEmpty: boolean;
}

/** Compute the closing entry for one entity + year (no posting). */
export async function computeYearEndClose(
  db: DB,
  orgId: string,
  locationId: string,
  year: number,
): Promise<CloseComputation> {
  const closeDate = `${year}-12-31`;
  const yearStart = `${year}-01-01`;

  // POSTED, non-CLOSING entries for this entity within the fiscal year.
  const { data: entries } = await db
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('status', 'POSTED')
    .neq('entry_type', 'CLOSING')
    .gte('entry_date', yearStart)
    .lte('entry_date', closeDate);

  const entryIds = (entries ?? []).map((e: Record<string, unknown>) => e.id as string);

  const retainedEarnings = await resolveRole(db, orgId, 'RETAINED_EARNINGS');

  if (entryIds.length === 0) {
    return {
      fiscalYear: year, closeDate, locationId, accounts: [],
      revenueCents: 0, expenseCents: 0, netIncomeCents: 0,
      retainedEarningsAccountId: retainedEarnings.id, lines: [], isEmpty: true,
    };
  }

  // P&L lines in those entries. Chunk the IN list to stay well under limits.
  const agg = new Map<string, { number: string; name: string; type: string; net: number }>();
  const chunkSize = 200;
  for (let i = 0; i < entryIds.length; i += chunkSize) {
    const chunk = entryIds.slice(i, i + chunkSize);
    const { data: lines } = await db
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents, accounts!inner(account_number, name, account_type)')
      .in('gl_entry_id', chunk)
      .in('accounts.account_type', PL_TYPES);
    for (const l of lines ?? []) {
      const acct = (l as Record<string, unknown>).accounts as unknown as { account_number: string; name: string; account_type: string };
      const id = (l as Record<string, unknown>).account_id as string;
      const cur = agg.get(id) ?? { number: acct.account_number, name: acct.name, type: acct.account_type, net: 0 };
      cur.net += Number((l as Record<string, unknown>).debit_cents ?? 0) - Number((l as Record<string, unknown>).credit_cents ?? 0);
      agg.set(id, cur);
    }
  }

  const accounts: CloseAccountLine[] = [];
  const lines: JournalEntryLineInput[] = [];
  let revenueCents = 0;
  let expenseCents = 0;

  for (const [accountId, a] of agg) {
    if (a.net === 0) continue;
    // Zero the account: post the opposite of its net.
    let debit = 0;
    let credit = 0;
    if (a.net < 0) {
      // credit-normal balance (revenue / other income) -> debit to zero
      debit = -a.net;
      revenueCents += -a.net;
    } else {
      // debit-normal balance (expense) -> credit to zero
      credit = a.net;
      expenseCents += a.net;
    }
    accounts.push({ accountId, accountNumber: a.number, name: a.name, accountType: a.type, balanceCents: a.net, debitCents: debit, creditCents: credit });
    lines.push({ account_id: accountId, debit_cents: debit, credit_cents: credit, location_id: locationId, memo: `Close ${a.number} ${a.name}` });
  }

  const netIncomeCents = revenueCents - expenseCents;

  // Offset to Retained Earnings so the entry balances.
  if (netIncomeCents > 0) {
    lines.push({ account_id: retainedEarnings.id, debit_cents: 0, credit_cents: netIncomeCents, location_id: locationId, memo: `Net income to retained earnings (FY${year})` });
  } else if (netIncomeCents < 0) {
    lines.push({ account_id: retainedEarnings.id, debit_cents: -netIncomeCents, credit_cents: 0, location_id: locationId, memo: `Net loss to retained earnings (FY${year})` });
  }

  return {
    fiscalYear: year, closeDate, locationId, accounts,
    revenueCents, expenseCents, netIncomeCents,
    retainedEarningsAccountId: retainedEarnings.id,
    lines,
    isEmpty: lines.length < 2,
  };
}

export interface RunCloseResult {
  success: boolean;
  closeId?: string;
  entryNumber?: string;
  netIncomeCents?: number;
  error?: string;
}

/** Run (post) the year-end close for one entity. */
export async function runYearEndClose(
  db: DB,
  orgId: string,
  locationId: string,
  year: number,
  actor: string | null = null,
): Promise<RunCloseResult> {
  // Guard: already closed (active) for this entity-year?
  const { data: existing } = await db
    .from('year_end_closes')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('fiscal_year', year)
    .eq('status', 'POSTED')
    .maybeSingle();
  if (existing?.id) {
    return { success: false, error: `FY${year} is already closed for this entity. Reverse the existing close to re-run.` };
  }

  let comp: CloseComputation;
  try {
    comp = await computeYearEndClose(db, orgId, locationId, year);
  } catch (e) {
    if (e instanceof PostingError) return { success: false, error: e.message };
    throw e;
  }

  if (comp.isEmpty) {
    return { success: false, error: `No temporary-account activity to close for FY${year}.` };
  }

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: locationId,
    entry_date: comp.closeDate,
    entry_type: 'CLOSING',
    memo: `Year-end close FY${year} — temporary accounts to retained earnings`,
    source_module: 'YEAR_END_CLOSE',
    created_by: null,
    lines: comp.lines,
  });
  if (!je.success || !je.entry_id) {
    // The most common cause is the Dec period being hard-closed; surface it clearly.
    return { success: false, error: je.error ?? 'Failed to post the closing entry.' };
  }

  const { data: rec, error: recErr } = await db
    .from('year_end_closes')
    .insert({
      org_id: orgId,
      location_id: locationId,
      fiscal_year: year,
      close_date: comp.closeDate,
      gl_entry_id: je.entry_id,
      revenue_cents: comp.revenueCents,
      expense_cents: comp.expenseCents,
      net_income_cents: comp.netIncomeCents,
      status: 'POSTED',
      created_by_user: actor,
    })
    .select('id')
    .single();
  if (recErr || !rec) {
    // Compensate: void the closing entry so the books don't carry an untracked close.
    await voidJournalEntry(db, orgId, je.entry_id, null, 'Auto-reversed: year-end close record failed to save');
    return { success: false, error: `Failed to record the close: ${recErr?.message ?? 'unknown'}` };
  }

  return { success: true, closeId: rec.id, entryNumber: je.entry_number, netIncomeCents: comp.netIncomeCents };
}

/** Reverse a year-end close: void the closing entry, mark the record REVERSED. */
export async function reverseYearEndClose(
  db: DB,
  orgId: string,
  closeId: string,
  reason: string,
  actor: string | null = null,
): Promise<{ success: boolean; error?: string }> {
  const { data: rec, error } = await db
    .from('year_end_closes')
    .select('id, gl_entry_id, status')
    .eq('org_id', orgId)
    .eq('id', closeId)
    .single();
  if (error || !rec) return { success: false, error: 'Close record not found.' };
  if (rec.status === 'REVERSED') return { success: false, error: 'Already reversed.' };

  if (rec.gl_entry_id) {
    const v = await voidJournalEntry(db, orgId, rec.gl_entry_id as string, null, `Year-end close reversed: ${reason}`);
    if (!v.success) return { success: false, error: v.error ?? 'Failed to void the closing entry.' };
  }

  const { error: upErr } = await db
    .from('year_end_closes')
    .update({ status: 'REVERSED', reversed_at: new Date().toISOString(), reversed_by_user: actor, reverse_reason: reason })
    .eq('id', closeId)
    .eq('org_id', orgId);
  if (upErr) return { success: false, error: upErr.message };
  return { success: true };
}

// ---- Overview ---------------------------------------------------------------

export interface YearEndEntityRow {
  locationId: string;
  locationName: string;
  revenueCents: number;
  expenseCents: number;
  netIncomeCents: number;
  closed: boolean;
  closeId: string | null;
  entryNumber: string | null;
  closeDate: string | null;
}

export interface YearEndOverview {
  fiscalYear: number;
  rows: YearEndEntityRow[];
  totals: { revenueCents: number; expenseCents: number; netIncomeCents: number; closedCount: number };
}

/** Per-entity net income + close status for a fiscal year. */
export async function getYearEndOverview(db: DB, orgId: string, year: number): Promise<YearEndOverview> {
  const { data: locs } = await db
    .schema('core').from('locations')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');

  // Active closes for this year.
  const { data: closes } = await db
    .from('year_end_closes')
    .select('id, location_id, net_income_cents, revenue_cents, expense_cents, close_date, gl_entry_id, status')
    .eq('org_id', orgId)
    .eq('fiscal_year', year)
    .eq('status', 'POSTED');
  const closeByLoc = new Map((closes ?? []).map((c: Record<string, unknown>) => [c.location_id as string, c]));

  // Entry numbers for closed entities.
  const entryIds = (closes ?? []).map((c: Record<string, unknown>) => c.gl_entry_id as string).filter(Boolean);
  const entryNumById = new Map<string, string>();
  if (entryIds.length > 0) {
    const { data: ents } = await db.from('gl_entries').select('id, entry_number').in('id', entryIds);
    for (const e of ents ?? []) entryNumById.set(e.id as string, e.entry_number as string);
  }

  const rows: YearEndEntityRow[] = [];
  for (const l of locs ?? []) {
    const locId = l.id as string;
    const closed = closeByLoc.get(locId);
    if (closed) {
      rows.push({
        locationId: locId,
        locationName: l.name as string,
        revenueCents: Number(closed.revenue_cents ?? 0),
        expenseCents: Number(closed.expense_cents ?? 0),
        netIncomeCents: Number(closed.net_income_cents ?? 0),
        closed: true,
        closeId: closed.id as string,
        entryNumber: closed.gl_entry_id ? entryNumById.get(closed.gl_entry_id as string) ?? null : null,
        closeDate: closed.close_date as string,
      });
    } else {
      // Not closed → compute live net income for the year.
      const comp = await computeYearEndClose(db, orgId, locId, year);
      rows.push({
        locationId: locId,
        locationName: l.name as string,
        revenueCents: comp.revenueCents,
        expenseCents: comp.expenseCents,
        netIncomeCents: comp.netIncomeCents,
        closed: false,
        closeId: null,
        entryNumber: null,
        closeDate: null,
      });
    }
  }

  const totals = rows.reduce(
    (acc, r) => ({
      revenueCents: acc.revenueCents + r.revenueCents,
      expenseCents: acc.expenseCents + r.expenseCents,
      netIncomeCents: acc.netIncomeCents + r.netIncomeCents,
      closedCount: acc.closedCount + (r.closed ? 1 : 0),
    }),
    { revenueCents: 0, expenseCents: 0, netIncomeCents: 0, closedCount: 0 },
  );

  return { fiscalYear: year, rows, totals };
}
