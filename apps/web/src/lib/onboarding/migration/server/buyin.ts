/**
 * Buy-in, server side: the client's real monthly volumes (live MeritBooks data first,
 * else what was staged from the old system) for the time-saved estimate, the reviewer and
 * thresholds for "what changes for you", and the first-week checklist computed from real
 * rows on this client (never a demo company).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { estimateTimeSaved, firstWeekChecklist, priorSystemFor, workflowFor, TERMINOLOGY, TIME_STANDARDS, type BuyInRole, type ChecklistItem, type TimeSavedLine, type VolumeFact, type WorkflowSection } from '../buyin';
import { getSourceSystem } from '../catalog';
import { loadPeople, loadSources, loadStaged, type ProjectRow } from './store';

type DB = SupabaseClient;

export interface BuyInView {
  clientName: string;
  priorSystem: string;
  role: BuyInRole;
  volumes: VolumeFact[];
  timeSaved: { lines: TimeSavedLine[]; beforeHours: number; afterHours: number; savedHours: number };
  standards: typeof TIME_STANDARDS;
  workflow: WorkflowSection;
  terminology: typeof TERMINOLOGY;
  checklist: ChecklistItem[];
  reviewerName: string | null;
}

function daysAgo(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function countWhere(q: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const r = await q;
    return r.count ?? 0;
  } catch {
    return 0;
  }
}

export async function buyInView(db: DB, orgId: string, project: ProjectRow, role: BuyInRole, today: string): Promise<BuyInView> {
  const loc = project.location_id;
  const since = daysAgo(today, 90);
  const [{ data: client }, sources, staged, people] = await Promise.all([
    db.schema('core').from('locations').select('name').eq('id', loc).maybeSingle(),
    loadSources(db, project.id),
    loadStaged(db, project.id, ['open_bill', 'open_invoice', 'vendor', 'customer', 'bank_balance']),
    loadPeople(db, orgId),
  ]);
  const clientName = (client as { name: string } | null)?.name ?? 'this client';
  const ledger = sources.find((s) => s.role === 'ledger_source');

  // Live volumes (last 90 days → per month).
  const [bankTxns, bills, invoices, bankAccounts] = await Promise.all([
    countWhere(db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gte('transaction_date', since)),
    countWhere(db.from('bills').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gte('bill_date', since)),
    countWhere(db.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gte('invoice_date', since)),
    countWhere(db.from('bank_accounts').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).eq('is_active', true)),
  ]);
  const per = (n: number) => Math.round(n / 3);
  const stagedCount = (e: string) => staged.filter((r) => r.entity === e).length;
  const volumes: VolumeFact[] = [];
  if (bankTxns > 0) volumes.push({ key: 'bank_txns', perMonth: per(bankTxns), basis: `${clientName}’s bank feed, last 90 days` });
  if (bills > 0) volumes.push({ key: 'bills', perMonth: per(bills), basis: 'Bills in MeritBooks, last 90 days' });
  else if (stagedCount('open_bill') > 0) volumes.push({ key: 'bills', perMonth: stagedCount('open_bill'), basis: 'At least the open bills at cutover (a floor — the real monthly count is usually higher)' });
  if (invoices > 0) volumes.push({ key: 'invoices', perMonth: per(invoices), basis: 'Invoices in MeritBooks, last 90 days' });
  else if (stagedCount('open_invoice') > 0) volumes.push({ key: 'invoices', perMonth: stagedCount('open_invoice'), basis: 'At least the open invoices at cutover (a floor)' });
  const acctCount = bankAccounts || stagedCount('bank_balance');
  if (acctCount > 0) volumes.push({ key: 'bank_accounts', perMonth: acctCount, basis: bankAccounts ? 'Bank accounts in MeritBooks' : 'Bank accounts in the dropped reconciliations' });

  // Checklist facts on this client, after the cutover.
  const after = project.cutover_date ?? since;
  const [approved, recs, billsEntered, sent, closed] = await Promise.all([
    countWhere(db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).in('status', ['APPROVED', 'POSTED']).gt('transaction_date', after)),
    countWhere(db.from('bank_reconciliations').select('id, bank_accounts!inner(location_id)', { count: 'exact', head: true }).eq('org_id', orgId).eq('bank_accounts.location_id', loc).eq('is_reconciled', true)),
    countWhere(db.from('bills').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gt('bill_date', after)),
    countWhere(db.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gt('invoice_date', after).neq('status', 'DRAFT')),
    countWhere(db.from('fiscal_periods').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('location_id', loc).gt('start_date', after).neq('status', 'OPEN')),
  ]);

  const reviewerName = project.reviewer_user_id ? people.find((p) => p.userId === project.reviewer_user_id)?.name ?? null : null;
  const sys = priorSystemFor(ledger?.system_id);
  return {
    clientName,
    priorSystem: ledger ? getSourceSystem(ledger.system_id)?.name ?? 'the old system' : 'the old system',
    role,
    volumes,
    timeSaved: estimateTimeSaved(volumes),
    standards: TIME_STANDARDS,
    workflow: workflowFor(role, sys, { reviewerName, billApprovalThresholdCents: null }),
    terminology: TERMINOLOGY.filter((t) => t.system === sys),
    checklist: firstWeekChecklist({ approvedBankTxns: approved, reconciliations: recs, billsEntered, invoicesSent: sent, periodsClosed: closed }, clientName),
    reviewerName,
  };
}
