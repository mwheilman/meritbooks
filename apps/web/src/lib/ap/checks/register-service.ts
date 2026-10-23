/**
 * The check register for one bank account (FPB §4.2, AC-13): filter / sort / page, the
 * outstanding / cleared / stale summary, and the gap check (missing numbers minus declared
 * sequence skips). Read-only; RLS + client scope through the caller's client.
 */

import {
  CheckError,
  loadBankAccount,
  loadNextNumber,
  loadProfile,
  todayIso,
  type CheckRow,
  type DB,
} from './db';
import { csvEscape, findGaps, formatRanges, isOutstanding, isPastVoidDate, isStale, STATUS_LABEL, type CheckStatus } from './register';

export type RegisterFilter = 'all' | 'outstanding' | 'cleared' | 'void' | 'spoiled' | 'stale';
export type RegisterSort = 'number' | 'date' | 'amount' | 'payee';

export interface RegisterQuery {
  filter?: RegisterFilter;
  q?: string | null;
  from?: string | null;
  to?: string | null;
  sort?: RegisterSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface RegisterRow {
  id: string;
  checkNumber: number;
  checkDate: string;
  payeeName: string;
  amountCents: number;
  status: CheckStatus;
  statusLabel: string;
  stale: boolean;
  pastVoidDate: boolean;
  memo: string | null;
  bills: Array<{ billId: string; billNumber: string | null; amountCents: number }>;
  printedBy: string;
  printedAt: string;
  clearedAt: string | null;
  clearedBankTransactionId: string | null;
  clearNote: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  reversalMode: string | null;
  replacesCheckId: string | null;
  sentToBank: boolean;
}

export interface RegisterResult {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string };
  rows: RegisterRow[];
  total: number;
  page: number;
  pageSize: number;
  nextNumber: number;
  summary: {
    outstandingCount: number;
    outstandingCents: number;
    clearedThisMonthCount: number;
    clearedThisMonthCents: number;
    staleCount: number;
    staleCents: number;
    voidCount: number;
    spoiledCount: number;
    notSentToBank: number;
    lowNumber: number | null;
    highNumber: number | null;
    gaps: number[];
    gapsLabel: string;
    gapsTruncated: boolean;
  };
  staleAfterDays: number;
}

const REGISTER_CAP = 20_000;

export async function loadRegister(db: DB, orgId: string, bankAccountId: string, query: RegisterQuery = {}, now = new Date()): Promise<RegisterResult> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const profile = await loadProfile(db, orgId, bankAccountId);
  const staleAfter = profile?.stale_after_days ?? 180;
  const voidAfter = profile?.void_after_days ?? 90;
  const today = todayIso(now);

  const { data, error } = await db
    .from('ap_checks')
    .select('*')
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .order('check_number', { ascending: false })
    .limit(REGISTER_CAP);
  if (error) throw new CheckError(`Could not load the register: ${error.message}`, 500);
  const all = (data ?? []) as CheckRow[];

  const { data: skips } = await db
    .from('check_sequence_events')
    .select('from_number, to_number')
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId);
  const gaps = findGaps(
    all.map((c) => Number(c.check_number)),
    ((skips ?? []) as Array<{ from_number: number; to_number: number }>).map((s) => ({ fromNumber: Number(s.from_number), toNumber: Number(s.to_number) })),
  );

  const month = today.slice(0, 7);
  const summary: RegisterResult['summary'] = {
    outstandingCount: 0, outstandingCents: 0, clearedThisMonthCount: 0, clearedThisMonthCents: 0,
    staleCount: 0, staleCents: 0, voidCount: 0, spoiledCount: 0, notSentToBank: 0,
    lowNumber: all.length ? Math.min(...all.map((c) => Number(c.check_number))) : null,
    highNumber: all.length ? Math.max(...all.map((c) => Number(c.check_number))) : null,
    gaps: gaps.missing, gapsLabel: formatRanges(gaps.missing), gapsTruncated: gaps.truncated,
  };
  for (const c of all) {
    const amt = Number(c.amount_cents);
    if (isOutstanding(c.status)) { summary.outstandingCount += 1; summary.outstandingCents += amt; }
    if (c.status === 'CLEARED' && (c.cleared_at ?? '').slice(0, 7) === month) { summary.clearedThisMonthCount += 1; summary.clearedThisMonthCents += amt; }
    if (isStale(c.status, c.check_date, today, staleAfter)) { summary.staleCount += 1; summary.staleCents += amt; }
    if (c.status === 'VOIDED') summary.voidCount += 1;
    if (c.status === 'SPOILED') summary.spoiledCount += 1;
    if ((c.status !== 'SPOILED' && !c.positive_pay_issue_export_id) || ((c.status === 'VOIDED' || c.status === 'SPOILED') && !c.positive_pay_void_export_id)) summary.notSentToBank += 1;
  }

  const q = (query.q ?? '').trim().toLowerCase();
  const filtered = all.filter((c) => {
    switch (query.filter ?? 'all') {
      case 'outstanding': if (!isOutstanding(c.status)) return false; break;
      case 'cleared': if (c.status !== 'CLEARED') return false; break;
      case 'void': if (c.status !== 'VOIDED') return false; break;
      case 'spoiled': if (c.status !== 'SPOILED') return false; break;
      case 'stale': if (!isStale(c.status, c.check_date, today, staleAfter)) return false; break;
      default: break;
    }
    if (query.from && c.check_date < query.from) return false;
    if (query.to && c.check_date > query.to) return false;
    if (q && !c.payee_name.toLowerCase().includes(q) && !String(c.check_number).includes(q)) return false;
    return true;
  });

  const dir = query.dir === 'asc' ? 1 : -1;
  const sort = query.sort ?? 'number';
  filtered.sort((a, b) => {
    const v = sort === 'amount' ? Number(a.amount_cents) - Number(b.amount_cents)
      : sort === 'date' ? a.check_date.localeCompare(b.check_date) || Number(a.check_number) - Number(b.check_number)
      : sort === 'payee' ? a.payee_name.localeCompare(b.payee_name)
      : Number(a.check_number) - Number(b.check_number);
    return v * dir;
  });

  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 500);
  const page = Math.max(query.page ?? 1, 1);
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Bills on the visible page.
  const ids = slice.map((c) => c.id);
  const billsByCheck = new Map<string, RegisterRow['bills']>();
  if (ids.length) {
    const { data: links } = await db
      .from('ap_check_payments')
      .select('check_id, bill_id, amount_cents')
      .eq('org_id', orgId)
      .in('check_id', ids);
    const linkRows = (links ?? []) as Array<{ check_id: string; bill_id: string; amount_cents: number }>;
    const billIds = Array.from(new Set(linkRows.map((l) => l.bill_id)));
    const { data: bills } = billIds.length
      ? await db.from('bills').select('id, bill_number').eq('org_id', orgId).in('id', billIds)
      : { data: [] };
    const num = new Map(((bills ?? []) as Array<{ id: string; bill_number: string | null }>).map((b) => [b.id, b.bill_number]));
    for (const l of linkRows) {
      const arr = billsByCheck.get(l.check_id) ?? [];
      arr.push({ billId: l.bill_id, billNumber: num.get(l.bill_id) ?? null, amountCents: Number(l.amount_cents) });
      billsByCheck.set(l.check_id, arr);
    }
  }

  return {
    bankAccount: { id: ba.id, name: ba.account_name, institution: ba.institution_name, mask: ba.account_mask, locationId: ba.location_id },
    rows: slice.map((c) => ({
      id: c.id,
      checkNumber: Number(c.check_number),
      checkDate: c.check_date,
      payeeName: c.payee_name,
      amountCents: Number(c.amount_cents),
      status: c.status,
      statusLabel: STATUS_LABEL[c.status],
      stale: isStale(c.status, c.check_date, today, staleAfter),
      pastVoidDate: isPastVoidDate(c.status, c.check_date, today, voidAfter),
      memo: c.memo,
      bills: billsByCheck.get(c.id) ?? [],
      printedBy: c.printed_by,
      printedAt: c.printed_at,
      clearedAt: c.cleared_at,
      clearedBankTransactionId: c.cleared_bank_transaction_id,
      clearNote: c.clear_note,
      voidedAt: c.voided_at,
      voidReason: c.void_reason,
      reversalMode: c.reversal_mode,
      replacesCheckId: c.replaces_check_id,
      sentToBank: !!c.positive_pay_issue_export_id,
    })),
    total: filtered.length,
    page,
    pageSize,
    nextNumber: await loadNextNumber(db, orgId, bankAccountId),
    summary,
    staleAfterDays: staleAfter,
  };
}

export function registerCsv(rows: readonly RegisterRow[]): string {
  const header = ['Check number', 'Date', 'Payee', 'Amount', 'Status', 'Stale', 'Bills', 'Memo', 'Printed by', 'Cleared', 'Voided', 'Void reason'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.checkNumber,
      r.checkDate,
      r.payeeName,
      `${Math.floor(r.amountCents / 100)}.${String(r.amountCents % 100).padStart(2, '0')}`,
      r.statusLabel,
      r.stale ? 'Yes' : '',
      r.bills.map((b) => b.billNumber ?? b.billId.slice(0, 8)).join(' '),
      r.memo ?? '',
      r.printedBy,
      r.clearedAt?.slice(0, 10) ?? '',
      r.voidedAt?.slice(0, 10) ?? '',
      r.voidReason ?? '',
    ].map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
