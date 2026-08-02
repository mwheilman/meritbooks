/**
 * Collections data loader (I/O). Hydrates everything the PURE worklist ranker
 * needs from real, RLS-scoped ledger data — open invoices, their reminder
 * history (public.invoice_events), payment applications, the per-customer
 * dossier (READ-ONLY reuse of lib/customers/dossier), and logged promises
 * (core.action_log). No demo data. The math/ranking lives in worklist.ts; this
 * file only fetches and shapes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCoreMap } from '@/lib/stitch-core';
import { buildDossier, type DossierInvoice, type DossierPayment } from '@/lib/customers/dossier';
import {
  buildWorklist,
  type WorklistAccount,
  type WorklistAccountInput,
  type WorklistInvoiceInput,
  type RiskLevel,
} from './worklist';
import {
  classifyPromises,
  PROMISE_ACTION,
  type PromiseToPay,
  type ClassifiedPromise,
} from './promises';
import { DUNNING_LADDER, type DunningStageKey } from './cadence';

const DAY_MS = 86_400_000;
const STAGE_KEYS = new Set<string>(DUNNING_LADDER.map((s) => s.key));

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
function daysBetween(to: Date, from: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
const num = (v: number | string | null | undefined): number => Number(v ?? 0);

interface InvRow {
  id: string; invoice_number: string; invoice_date: string; due_date: string;
  total_cents: number | string; amount_paid_cents: number | string; balance_cents: number | string;
  status: string; customer_id: string | null; location_id: string | null;
}

export interface WorklistResult {
  asOf: string;
  accounts: WorklistAccount[];
  kpis: {
    totalOverdueCents: number;
    totalOpenCents: number;
    accountsInWorklist: number;
    brokenPromiseCount: number;
    remindersDueCount: number;
    /** Overdue dollars weighted by predicted lateness, summed across accounts. */
    totalExpectedValueAtRiskCents: number;
    /** Accounts predicted to pay LATE (predicted pay date beyond the due date). */
    predictedLateCount: number;
  };
}

/**
 * Load + rank the collections worklist for a tenant. RLS-scoped: pass an
 * org-scoped client and the resolved orgId (never "first org").
 */
export async function loadWorklist(
  supabase: SupabaseClient,
  orgId: string,
  opts: { asOf?: string; locationId?: string | null } = {},
): Promise<WorklistResult> {
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const asOfDate = parseDate(asOf) ?? new Date();

  // ── 1. Non-draft, non-void invoices (need PAID too for pay-history). ──────────
  let q = supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, balance_cents, status, customer_id, location_id')
    .eq('org_id', orgId)
    .not('status', 'in', '("DRAFT","VOIDED")');
  if (opts.locationId && opts.locationId !== 'all') q = q.eq('location_id', opts.locationId);
  const { data: invData } = await q;
  const invoices = (invData ?? []) as unknown as InvRow[];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const invoiceIds = invoices.map((i) => i.id);

  // ── 2. REMINDER_SENT history → last stage + last reminder per invoice. ────────
  interface Reminder { invoice_id: string; created_at: string; meta: Record<string, unknown> | null }
  const reminders: Reminder[] = [];
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const chunk = invoiceIds.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data } = await supabase
      .from('invoice_events')
      .select('invoice_id, created_at, meta')
      .eq('org_id', orgId)
      .eq('event_type', 'REMINDER_SENT')
      .in('invoice_id', chunk);
    if (data) reminders.push(...(data as Reminder[]));
  }
  const reminderState = new Map<string, { lastStageSent: DunningStageKey | null; lastStageOrder: number; lastReminderAt: string | null; count: number }>();
  for (const r of reminders) {
    const st = reminderState.get(r.invoice_id) ?? { lastStageSent: null, lastStageOrder: 0, lastReminderAt: null, count: 0 };
    st.count += 1;
    if (!st.lastReminderAt || r.created_at > st.lastReminderAt) st.lastReminderAt = r.created_at;
    const raw = (r.meta?.stage ?? r.meta?.tier) as string | undefined;
    if (raw && STAGE_KEYS.has(raw)) {
      const order = DUNNING_LADDER.find((s) => s.key === raw)?.order ?? 0;
      if (order > st.lastStageOrder) { st.lastStageOrder = order; st.lastStageSent = raw as DunningStageKey; }
    }
    reminderState.set(r.invoice_id, st);
  }

  // ── 3. Payment applications (dossier days-to-pay + promise paid-since). ────────
  const { data: payRows } = await supabase
    .from('customer_payments')
    .select('id, customer_id, payment_date')
    .eq('org_id', orgId)
    .limit(5000);
  const payDateById = new Map<string, string>();
  const payCustById = new Map<string, string>();
  for (const p of (payRows ?? []) as Array<{ id: string; customer_id: string; payment_date: string }>) {
    payDateById.set(p.id, p.payment_date);
    payCustById.set(p.id, p.customer_id);
  }
  interface AppRow { payment_id: string; invoice_id: string; amount_cents: number | string; paymentDate: string }
  const applications: AppRow[] = [];
  const payIds = [...payDateById.keys()];
  for (let i = 0; i < payIds.length; i += 500) {
    const slice = payIds.slice(i, i + 500);
    if (slice.length === 0) break;
    const { data: apps } = await supabase
      .from('payment_applications')
      .select('payment_id, invoice_id, amount_cents')
      .eq('org_id', orgId)
      .in('payment_id', slice);
    for (const a of (apps ?? []) as Array<{ payment_id: string; invoice_id: string; amount_cents: number | string }>) {
      const pd = payDateById.get(a.payment_id);
      if (pd) applications.push({ ...a, paymentDate: pd });
    }
  }

  // ── 4. Promises from the audit rail. ──────────────────────────────────────────
  const { data: promiseRows } = await supabase
    .schema('core')
    .from('action_log')
    .select('id, subject_id, metadata, created_at')
    .eq('org_id', orgId)
    .eq('action', PROMISE_ACTION)
    .order('created_at', { ascending: false })
    .limit(2000);
  const promises: PromiseToPay[] = [];
  for (const r of (promiseRows ?? []) as Array<{ id: string; subject_id: string | null; metadata: Record<string, unknown> | null; created_at: string }>) {
    const m = r.metadata ?? {};
    const customerId = (m.customerId as string) ?? '';
    if (!customerId) continue;
    promises.push({
      id: r.id,
      customerId,
      invoiceId: (m.invoiceId as string) ?? null,
      amountCents: num(m.amountCents as number),
      promiseDate: (m.promiseDate as string) ?? '',
      note: (m.note as string) ?? null,
      createdAt: r.created_at,
    });
  }

  // ── 5. Org TTM revenue for the concentration signal. ──────────────────────────
  const ttmStart = new Date(asOfDate.getTime() - 365 * DAY_MS).toISOString().slice(0, 10);
  let orgTtmRevenueCents = 0;
  for (const inv of invoices) {
    if (inv.status === 'VOIDED' || inv.status === 'DRAFT') continue;
    if (inv.invoice_date >= ttmStart && inv.invoice_date <= asOf) orgTtmRevenueCents += num(inv.total_cents);
  }

  // ── 6. Customer master (credit limit, terms, name, email). ────────────────────
  const customerIds = [...new Set(invoices.map((i) => i.customer_id).filter(Boolean))] as string[];
  const custMap = await fetchCoreMap<{
    id: string; name: string; display_name: string | null; email: string | null;
    credit_limit_cents: number | string | null; payment_terms_days: number | null;
  }>(supabase, 'customers', 'id, name, display_name, email, credit_limit_cents, payment_terms_days', customerIds);

  // ── 7. Group per customer → dossier risk + worklist inputs + promises. ─────────
  const byCustomer = new Map<string, InvRow[]>();
  for (const inv of invoices) {
    const cid = inv.customer_id ?? 'UNASSIGNED';
    const arr = byCustomer.get(cid) ?? [];
    arr.push(inv);
    byCustomer.set(cid, arr);
  }

  // paid-since helper for promise classification.
  const paidSinceFor = (invoiceId: string | null, customerId: string, sinceIso: string): number => {
    const sinceDate = sinceIso.slice(0, 10);
    let sum = 0;
    for (const a of applications) {
      if (a.paymentDate <= sinceDate) continue;
      if (invoiceId) {
        if (a.invoice_id === invoiceId) sum += num(a.amount_cents);
      } else if (payCustById.get(a.payment_id) === customerId) {
        sum += num(a.amount_cents);
      }
    }
    return sum;
  };

  const accountsInput: WorklistAccountInput[] = [];

  for (const [cid, invs] of byCustomer) {
    const cust = cid !== 'UNASSIGNED' ? custMap.get(cid) : undefined;
    const customerName = cust ? (cust.display_name || cust.name) : 'Unassigned';
    const customerEmail = cust?.email ?? null;
    const termsDays = cust?.payment_terms_days ?? 30;
    const creditLimitCents = cust?.credit_limit_cents != null ? num(cust.credit_limit_cents) : null;

    // Dossier inputs (all this customer's invoices + their payment applications).
    const dossierInvoices: DossierInvoice[] = invs.map((r) => ({
      invoiceDate: r.invoice_date, dueDate: r.due_date,
      totalCents: num(r.total_cents), balanceCents: num(r.balance_cents), status: r.status,
    }));
    const dossierPayments: DossierPayment[] = [];
    for (const a of applications) {
      const inv = invoiceById.get(a.invoice_id);
      if (!inv || inv.customer_id !== cid) continue;
      dossierPayments.push({
        paymentDate: a.paymentDate, invoiceDate: inv.invoice_date, dueDate: inv.due_date,
        amountCents: num(a.amount_cents),
      });
    }
    const dossier = buildDossier({
      customerName, creditLimitCents, termsDays,
      invoices: dossierInvoices, payments: dossierPayments, orgTtmRevenueCents, asOf,
    });

    // Open invoices for this customer (worklist inputs).
    let openBalanceCents = 0;
    let overdueBalanceCents = 0;
    const wlInvoices: WorklistInvoiceInput[] = [];
    for (const inv of invs) {
      const balance = num(inv.balance_cents);
      const invDate = parseDate(inv.invoice_date);
      const dueDate = parseDate(inv.due_date);
      const isOpen = balance > 0 && invDate != null && invDate <= asOfDate
        && inv.status !== 'PAID' && inv.status !== 'VOIDED' && inv.status !== 'WRITTEN_OFF';
      if (!isOpen) continue;
      openBalanceCents += balance;
      const daysOverdue = dueDate ? Math.max(0, daysBetween(asOfDate, dueDate)) : 0;
      if (daysOverdue > 0) overdueBalanceCents += balance;
      const st = reminderState.get(inv.id);
      wlInvoices.push({
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        dueDate: inv.due_date,
        balanceCents: balance,
        daysOverdue,
        lastStageSent: st?.lastStageSent ?? null,
        lastReminderAt: st?.lastReminderAt ?? null,
        reminderCount: st?.count ?? 0,
      });
    }
    if (wlInvoices.length === 0) continue; // nothing open to chase

    // Classify this customer's promises (latest per target authoritative).
    const custPromises = promises.filter((p) => p.customerId === cid);
    const classified: ClassifiedPromise[] = classifyPromises(
      custPromises,
      (p) => {
        if (p.invoiceId) {
          const inv = invoiceById.get(p.invoiceId);
          const bal = inv ? num(inv.balance_cents) : 0;
          return { paidSinceCents: paidSinceFor(p.invoiceId, cid, p.createdAt), openBalanceCents: bal, settled: !inv || inv.status === 'PAID' || bal <= 0 };
        }
        return { paidSinceCents: paidSinceFor(null, cid, p.createdAt), openBalanceCents: overdueBalanceCents, settled: overdueBalanceCents <= 0 };
      },
      asOf,
      { latestOnly: true },
    );

    accountsInput.push({
      customerId: cid === 'UNASSIGNED' ? null : cid,
      customerName,
      customerEmail,
      riskLevel: dossier.risk.level as RiskLevel,
      riskFlags: dossier.risk.flags,
      riskSummary: dossier.risk.summary,
      avgDaysBeyondTerms: dossier.behavior.avgDaysBeyondTerms,
      openBalanceCents,
      overdueBalanceCents,
      invoices: wlInvoices,
      promises: classified,
      termsDays,
      payHistory: {
        sampleSize: dossier.behavior.paidApplicationCount,
        medianDaysToPay: dossier.behavior.medianDaysToPay,
        avgDaysToPay: dossier.behavior.avgDaysToPay,
        worstDaysToPay: dossier.behavior.worstDaysToPay,
        avgDaysBeyondTerms: dossier.behavior.avgDaysBeyondTerms,
        onTimeRate: dossier.behavior.onTimeRate,
      },
    });
  }

  const accounts = buildWorklist(accountsInput, asOf);

  return {
    asOf,
    accounts,
    kpis: {
      totalOverdueCents: accounts.reduce((s, a) => s + a.overdueBalanceCents, 0),
      totalOpenCents: accounts.reduce((s, a) => s + a.openBalanceCents, 0),
      accountsInWorklist: accounts.filter((a) => a.overdueInvoiceCount > 0).length,
      brokenPromiseCount: accounts.reduce((s, a) => s + a.brokenPromiseCount, 0),
      remindersDueCount: accounts.filter((a) => a.reminderDue).length,
      totalExpectedValueAtRiskCents: accounts.reduce((s, a) => s + a.expectedValueAtRiskCents, 0),
      predictedLateCount: accounts.filter((a) => (a.focusPrediction?.predictedDaysLate ?? 0) > 0).length,
    },
  };
}
