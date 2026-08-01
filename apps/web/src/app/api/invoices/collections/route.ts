export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/invoices/collections — the AR Collections / DSO surface.
 *
 * The named delta vs QBO/Sage (FPB §7, D7.1/D7.2): AR aging exists (`v_ar_aging`)
 * but DSO and collection KPIs did not. This route computes them from real ledger
 * data — no snapshot table, no demo arrays — and returns everything the
 * collections dashboard renders:
 *
 *   • Aging buckets (CURRENT / 1-30 / 31-60 / 61-90 / 90+) as of a chosen date,
 *     agable by due date (default) or invoice date (AC7.2).
 *   • Headline KPIs: total AR, overdue AR, % current, DSO, average days-to-pay.
 *   • A worklist of open/overdue invoices ranked by a $-×-age priority score,
 *     each carrying its real delivery timeline (last sent / viewed / reminder)
 *     from public.invoice_events so a collector knows what's already been tried.
 *   • A per-customer rollup (open, overdue, oldest, avg days-to-pay, buckets)
 *     with each customer's open invoices for drill-down.
 *
 * RLS-scoped (requireAuthedContext) — the tenant is the token claim, not
 * "organizations limit 1", so this cannot leak across orgs.
 *
 * HONESTY NOTE: as-of aging re-buckets by the chosen date, but balances are the
 * current open balance (`balance_cents`) — we do not reconstruct a point-in-time
 * balance because MeritBooks does not yet snapshot AR. A true "as of period-end"
 * balance and a full CEI both need a periodic AR snapshot (see NEEDS CENTRAL in
 * the handoff). Average days-to-pay is the collection-effectiveness metric that
 * IS computable from real paid events, so that is what we surface.
 */

const DAY_MS = 86_400_000;

/** Parse a YYYY-MM-DD (or ISO) date to a UTC-midnight Date; null if invalid. */
function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
function daysBetween(to: Date, from: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

type Bucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
const EMPTY_BUCKETS = (): Record<Bucket, { count: number; balanceCents: number }> => ({
  CURRENT: { count: 0, balanceCents: 0 },
  '1-30': { count: 0, balanceCents: 0 },
  '31-60': { count: 0, balanceCents: 0 },
  '61-90': { count: 0, balanceCents: 0 },
  '90+': { count: 0, balanceCents: 0 },
});

function bucketFor(daysPast: number): Bucket {
  if (daysPast <= 0) return 'CURRENT';
  if (daysPast <= 30) return '1-30';
  if (daysPast <= 60) return '31-60';
  if (daysPast <= 90) return '61-90';
  return '90+';
}

interface InvRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_cents: number | string;
  amount_paid_cents: number | string;
  balance_cents: number | string;
  status: string;
  customer_id: string | null;
  location_id: string | null;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const asOf = parseDate(searchParams.get('as_of')) ?? new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const agingMethod = searchParams.get('aging_method') === 'INVOICE_DATE' ? 'INVOICE_DATE' : 'DUE_DATE';
  const dsoDays = Math.min(365, Math.max(30, parseInt(searchParams.get('dso_days') ?? '90', 10) || 90));
  const windowStart = new Date(asOf.getTime() - dsoDays * DAY_MS);

  // ── Pull every non-draft, non-void invoice for the tenant (RLS-scoped). We
  // need PAID rows too: they still count as credit sales for DSO and feed
  // days-to-pay. Location filter is optional. ────────────────────────────────
  let q = supabase
    .from('invoices')
    .select(
      'id, invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, balance_cents, status, customer_id, location_id',
    )
    .eq('org_id', orgId)
    .not('status', 'in', '("DRAFT","VOIDED")');
  if (locationId && locationId !== 'all') q = q.eq('location_id', locationId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const invoices = (data ?? []) as unknown as InvRow[];

  const num = (v: number | string | null | undefined) => Number(v ?? 0);

  // ── Delivery timeline + paid-date events, batched for the invoices we care
  // about (open ones for the worklist, plus any that were paid in-window). ────
  const eventInvoiceIds = invoices.map((i) => i.id);
  const events: Array<{ invoice_id: string; event_type: string; created_at: string }> = [];
  // Chunk the IN() list so a large book does not blow the URL length.
  for (let i = 0; i < eventInvoiceIds.length; i += 200) {
    const chunk = eventInvoiceIds.slice(i, i + 200);
    if (chunk.length === 0) break;
    const { data: evs } = await supabase
      .from('invoice_events')
      .select('invoice_id, event_type, created_at')
      .eq('org_id', orgId)
      .in('invoice_id', chunk)
      .in('event_type', ['SENT', 'VIEWED', 'REMINDER_SENT', 'MARKED_PAID', 'PAY_SUCCEEDED']);
    if (evs) events.push(...(evs as typeof events));
  }

  // Index events per invoice → last/count per meaningful type + a paid date.
  interface Timeline {
    lastSentAt: string | null; sentCount: number;
    lastViewedAt: string | null; viewCount: number;
    lastReminderAt: string | null; reminderCount: number;
    paidAt: string | null;
  }
  const timelineByInv = new Map<string, Timeline>();
  for (const inv of invoices) {
    timelineByInv.set(inv.id, {
      lastSentAt: null, sentCount: 0, lastViewedAt: null, viewCount: 0,
      lastReminderAt: null, reminderCount: 0, paidAt: null,
    });
  }
  for (const e of events) {
    const t = timelineByInv.get(e.invoice_id);
    if (!t) continue;
    switch (e.event_type) {
      case 'SENT':
        t.sentCount++; if (!t.lastSentAt || e.created_at > t.lastSentAt) t.lastSentAt = e.created_at; break;
      case 'VIEWED':
        t.viewCount++; if (!t.lastViewedAt || e.created_at > t.lastViewedAt) t.lastViewedAt = e.created_at; break;
      case 'REMINDER_SENT':
        t.reminderCount++; if (!t.lastReminderAt || e.created_at > t.lastReminderAt) t.lastReminderAt = e.created_at; break;
      case 'MARKED_PAID':
      case 'PAY_SUCCEEDED':
        if (!t.paidAt || e.created_at > t.paidAt) t.paidAt = e.created_at; break;
    }
  }

  // ── Aggregate. ──────────────────────────────────────────────────────────
  const buckets = EMPTY_BUCKETS();
  let totalAR = 0;
  let overdueAR = 0;
  let creditSales = 0;

  // Per-customer accumulators.
  interface CustAcc {
    customerId: string; openBalanceCents: number; overdueBalanceCents: number;
    invoiceCount: number; overdueCount: number; oldestDaysOverdue: number;
    buckets: Record<Bucket, { count: number; balanceCents: number }>;
    lastContactAt: string | null;
    daysToPaySum: number; daysToPayCount: number;
    invoices: WorklistRow[];
  }
  const custMapAcc = new Map<string, CustAcc>();

  interface WorklistRow {
    id: string; invoiceNumber: string; customerId: string | null;
    invoiceDate: string; dueDate: string; totalCents: number; balanceCents: number;
    daysOverdue: number; bucket: Bucket; status: string; locationId: string | null;
    lastSentAt: string | null; sentCount: number;
    lastViewedAt: string | null; viewCount: number;
    lastReminderAt: string | null; reminderCount: number;
    priorityScore: number;
  }
  const worklist: WorklistRow[] = [];

  // Portfolio-wide days-to-pay.
  let dtpSum = 0;
  let dtpCount = 0;

  for (const inv of invoices) {
    const invDate = parseDate(inv.invoice_date);
    const dueDate = parseDate(inv.due_date);
    if (!invDate) continue;

    // Credit sales = invoiced amount whose invoice_date falls in the trailing
    // DSO window ending as-of.
    if (invDate > windowStart && invDate <= asOf) creditSales += num(inv.total_cents);

    // Days-to-pay: contributed by invoices whose paid event landed in-window.
    const tl = timelineByInv.get(inv.id);
    if (tl?.paidAt) {
      const paid = parseDate(tl.paidAt);
      if (paid && paid > windowStart && paid <= asOf) {
        const dtp = Math.max(0, daysBetween(paid, invDate));
        dtpSum += dtp; dtpCount++;
      }
    }

    // Open receivable as of the chosen date: issued on/before as-of and still
    // carrying a balance and not voided/written-off.
    const balance = num(inv.balance_cents);
    const isOpen = balance > 0 && invDate <= asOf && inv.status !== 'VOIDED' && inv.status !== 'WRITTEN_OFF' && inv.status !== 'PAID';
    if (!isOpen) continue;

    const agingRef = agingMethod === 'INVOICE_DATE' ? invDate : (dueDate ?? invDate);
    const daysPast = daysBetween(asOf, agingRef);
    const bucket = bucketFor(daysPast);
    const daysOverdueByDue = dueDate ? daysBetween(asOf, dueDate) : 0;

    totalAR += balance;
    buckets[bucket].count++;
    buckets[bucket].balanceCents += balance;
    if (daysOverdueByDue > 0) overdueAR += balance;

    // Customer rollup.
    const cid = inv.customer_id ?? 'UNASSIGNED';
    let acc = custMapAcc.get(cid);
    if (!acc) {
      acc = {
        customerId: cid, openBalanceCents: 0, overdueBalanceCents: 0, invoiceCount: 0,
        overdueCount: 0, oldestDaysOverdue: 0, buckets: EMPTY_BUCKETS(), lastContactAt: null,
        daysToPaySum: 0, daysToPayCount: 0, invoices: [],
      };
      custMapAcc.set(cid, acc);
    }
    acc.openBalanceCents += balance;
    acc.invoiceCount++;
    acc.buckets[bucket].count++;
    acc.buckets[bucket].balanceCents += balance;
    if (daysOverdueByDue > 0) {
      acc.overdueBalanceCents += balance;
      acc.overdueCount++;
      if (daysOverdueByDue > acc.oldestDaysOverdue) acc.oldestDaysOverdue = daysOverdueByDue;
    }
    const lastContact = [tl?.lastSentAt, tl?.lastReminderAt].filter(Boolean).sort().at(-1) ?? null;
    if (lastContact && (!acc.lastContactAt || lastContact > acc.lastContactAt)) acc.lastContactAt = lastContact;

    const row: WorklistRow = {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      customerId: inv.customer_id,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      totalCents: num(inv.total_cents),
      balanceCents: balance,
      daysOverdue: Math.max(0, daysOverdueByDue),
      bucket,
      status: inv.status,
      locationId: inv.location_id,
      lastSentAt: tl?.lastSentAt ?? null,
      sentCount: tl?.sentCount ?? 0,
      lastViewedAt: tl?.lastViewedAt ?? null,
      viewCount: tl?.viewCount ?? 0,
      lastReminderAt: tl?.lastReminderAt ?? null,
      reminderCount: tl?.reminderCount ?? 0,
      // Rank worst offenders up: dollars weighted by how overdue they are.
      priorityScore: Math.round(balance * (1 + Math.min(daysOverdueByDue, 180) / 30)),
    };
    acc.invoices.push(row);
    // Worklist is the overdue subset (a collector chases the past-due).
    if (daysOverdueByDue > 0) worklist.push(row);
  }

  // Per-customer days-to-pay (recompute over paid invoices regardless of open).
  for (const inv of invoices) {
    const tl = timelineByInv.get(inv.id);
    const invDate = parseDate(inv.invoice_date);
    if (!tl?.paidAt || !invDate) continue;
    const paid = parseDate(tl.paidAt);
    if (!paid || paid <= windowStart || paid > asOf) continue;
    const cid = inv.customer_id ?? 'UNASSIGNED';
    const acc = custMapAcc.get(cid);
    if (!acc) continue;
    acc.daysToPaySum += Math.max(0, daysBetween(paid, invDate));
    acc.daysToPayCount++;
  }

  // ── Stitch customer + location names from core. ─────────────────────────
  const customerIds = [...custMapAcc.keys()].filter((k) => k !== 'UNASSIGNED');
  const locationIds = [...new Set(invoices.map((i) => i.location_id).filter(Boolean))] as string[];
  const [custNameMap, locNameMap] = await Promise.all([
    fetchCoreMap<{ id: string; name: string; email: string | null }>(supabase, 'customers', 'id, name, email', customerIds),
    fetchCoreMap<{ id: string; name: string; short_code: string }>(supabase, 'locations', 'id, name, short_code', locationIds),
  ]);

  const dso = creditSales > 0 ? Math.round((totalAR / creditSales) * dsoDays * 10) / 10 : null;
  const avgDaysToPay = dtpCount > 0 ? Math.round((dtpSum / dtpCount) * 10) / 10 : null;
  const pctCurrent = totalAR > 0 ? Math.round(((totalAR - overdueAR) / totalAR) * 1000) / 10 : null;

  const worklistOut = worklist
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((r) => ({
      ...r,
      customerName: r.customerId ? custNameMap.get(r.customerId)?.name ?? 'Unknown customer' : 'Unassigned',
      customerEmail: r.customerId ? custNameMap.get(r.customerId)?.email ?? null : null,
      locationName: r.locationId ? locNameMap.get(r.locationId)?.name ?? null : null,
      locationCode: r.locationId ? locNameMap.get(r.locationId)?.short_code ?? null : null,
    }));

  const customersOut = [...custMapAcc.values()]
    .map((c) => {
      const cName = c.customerId === 'UNASSIGNED' ? 'Unassigned' : custNameMap.get(c.customerId)?.name ?? 'Unknown customer';
      const cEmail = c.customerId === 'UNASSIGNED' ? null : custNameMap.get(c.customerId)?.email ?? null;
      return {
        customerId: c.customerId === 'UNASSIGNED' ? null : c.customerId,
        customerName: cName,
        customerEmail: cEmail,
        openBalanceCents: c.openBalanceCents,
        overdueBalanceCents: c.overdueBalanceCents,
        invoiceCount: c.invoiceCount,
        overdueCount: c.overdueCount,
        oldestDaysOverdue: c.oldestDaysOverdue,
        avgDaysToPay: c.daysToPayCount > 0 ? Math.round((c.daysToPaySum / c.daysToPayCount) * 10) / 10 : null,
        lastContactAt: c.lastContactAt,
        buckets: c.buckets,
        invoices: c.invoices
          .sort((a, b) => b.priorityScore - a.priorityScore)
          .map((r) => ({
            ...r,
            customerName: cName,
            customerEmail: cEmail,
            locationName: r.locationId ? locNameMap.get(r.locationId)?.name ?? null : null,
            locationCode: r.locationId ? locNameMap.get(r.locationId)?.short_code ?? null : null,
          })),
      };
    })
    .sort((a, b) => b.overdueBalanceCents - a.overdueBalanceCents || b.openBalanceCents - a.openBalanceCents);

  return NextResponse.json({
    asOf: asOf.toISOString().slice(0, 10),
    agingMethod,
    dsoDays,
    kpis: {
      totalArCents: totalAR,
      overdueArCents: overdueAR,
      currentArCents: totalAR - overdueAR,
      pctCurrent,          // % of AR not yet past due
      dso,                 // days sales outstanding over the trailing window
      avgDaysToPay,        // mean days invoice_date → paid, trailing window
      creditSalesCents: creditSales,
      openInvoiceCount: worklist.length + (totalAR > 0 ? customersOut.reduce((s, c) => s + (c.invoiceCount - c.overdueCount), 0) : 0),
      overdueInvoiceCount: worklist.length,
      customerCount: customersOut.length,
    },
    buckets,
    worklist: worklistOut,
    customers: customersOut,
  });
}
