/**
 * GL actuals for budgets (Wave 4B, AC-B16): POSTED entries of one company in a date range, by
 * account × department × month, natural sign by account type (income credit-positive, expense
 * debit-positive) — the same rule /api/budgets/vs-actual uses, so the two always agree.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { natureOfAccountType, type MonthKey } from '@/lib/analytics';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import type { AccountLite, GlDrillLine } from '../types';
import { must } from './data';

type Row = Record<string, unknown>;

export interface ActualsQuery {
  locationId: string;
  /** Inclusive ISO dates. */
  from: string;
  to: string;
  /** undefined = every department and company-level; null = company-level only; list = those departments. */
  departmentIds?: readonly string[] | null;
  accountId?: string;
}

export interface ActualCell {
  accountId: string;
  departmentId: string | null;
  month: MonthKey;
  /** debit − credit */
  netDebitCents: number;
}

async function postedEntries(db: SupabaseClient, q: ActualsQuery): Promise<Map<string, { date: string; number: string; memo: string | null }>> {
  const rows = must(
    await fetchAll<Row>(
      () => db.from('gl_entries').select('id, entry_date, entry_number, memo').eq('status', 'POSTED').eq('location_id', q.locationId).gte('entry_date', q.from).lte('entry_date', q.to),
      { label: 'budget actuals entries', orderBy: 'id' },
    ),
    'gl entries',
  ) as Row[];
  const out = new Map<string, { date: string; number: string; memo: string | null }>();
  for (const r of rows) out.set(String(r.id), { date: String(r.entry_date).slice(0, 10), number: String(r.entry_number ?? ''), memo: r.memo == null ? null : String(r.memo) });
  return out;
}

async function linesFor(db: SupabaseClient, entryIds: string[], q: ActualsQuery): Promise<Row[]> {
  if (entryIds.length === 0) return [];
  return must(
    await fetchAllIn<Row>(
      entryIds,
      (chunk) => {
        let lq = db.from('gl_entry_lines').select('id, gl_entry_id, account_id, department_id, debit_cents, credit_cents, memo').in('gl_entry_id', chunk);
        if (q.departmentIds === null) lq = lq.is('department_id', null);
        else if (q.departmentIds && q.departmentIds.length === 1) lq = lq.eq('department_id', q.departmentIds[0]);
        else if (q.departmentIds && q.departmentIds.length > 1) lq = lq.in('department_id', [...q.departmentIds]);
        if (q.accountId) lq = lq.eq('account_id', q.accountId);
        return lq;
      },
      { label: 'budget actuals lines', orderBy: 'id' },
    ),
    'gl lines',
  ) as Row[];
}

export async function loadActualCells(db: SupabaseClient, q: ActualsQuery): Promise<ActualCell[]> {
  if (q.departmentIds && q.departmentIds.length === 0) return [];
  const entries = await postedEntries(db, q);
  const lines = await linesFor(db, [...entries.keys()], q);
  const agg = new Map<string, ActualCell>();
  for (const l of lines) {
    const e = entries.get(String(l.gl_entry_id));
    if (!e) continue;
    const month = e.date.slice(0, 7);
    const dept = l.department_id == null ? null : String(l.department_id);
    const k = `${dept ?? ''}|${l.account_id}|${month}`;
    const net = Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0);
    const cur = agg.get(k);
    if (cur) cur.netDebitCents += net;
    else agg.set(k, { accountId: String(l.account_id), departmentId: dept, month, netDebitCents: net });
  }
  return [...agg.values()];
}

/** Natural amount of a debit − credit figure for an account (0 for balance-sheet accounts). */
export function naturalOf(account: AccountLite | undefined, netDebitCents: number): number {
  if (!account) return 0;
  const n = natureOfAccountType(account.type, account.subType);
  if (!n) return 0;
  return n === 'income' ? -netDebitCents : netDebitCents;
}

/** GL lines behind one department × account × window (the drill). */
export async function drillLines(db: SupabaseClient, q: ActualsQuery & { accountId: string }, account: AccountLite | undefined, limit = 500): Promise<GlDrillLine[]> {
  const entries = await postedEntries(db, q);
  const lines = await linesFor(db, [...entries.keys()], q);
  return lines
    .map((l) => {
      const e = entries.get(String(l.gl_entry_id))!;
      const debit = Number(l.debit_cents ?? 0);
      const credit = Number(l.credit_cents ?? 0);
      return {
        lineId: String(l.id),
        entryId: String(l.gl_entry_id),
        entryNumber: e.number,
        entryDate: e.date,
        memo: (l.memo as string | null) ?? e.memo,
        debitCents: debit,
        creditCents: credit,
        naturalCents: naturalOf(account, debit - credit),
      };
    })
    .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || a.entryNumber.localeCompare(b.entryNumber))
    .slice(0, limit);
}
