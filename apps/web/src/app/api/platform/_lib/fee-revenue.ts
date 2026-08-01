/**
 * Operator Console — cross-tenant application-fee revenue aggregation.
 *
 * This is a PLATFORM-plane analytics view: the fee income MeritBooks (the operator)
 * earns across every tenant. Per the canon, platform-fee revenue is an analytics
 * concern, NOT a per-payment GL posting — so this report is computed from the
 * payment sub-ledger, never from a fee-income ledger account.
 *
 * FEE DATA SOURCE (important):
 *   The realized application fee is stamped into the Stripe PaymentIntent metadata
 *   (`app_fee_cents`) at charge time, but it is NOT persisted queryably in our
 *   database — `public.customer_payments` has no fee column, and the invoice_events
 *   timeline stores the amount charged, not the fee. So we DERIVE the fee exactly
 *   the way the intent route computed it: `computeFee(schedule, method, base)` where
 *   `base` = the payment's `amount_cents` (the A/R relieved) and `schedule` = the
 *   merchant's fee schedule *in force on the payment date* (versioned rows, with the
 *   platform default as fallback). This reproduces the charged fee faithfully.
 *
 *   Only Stripe-processed payments earn a platform fee, so we count solely payments
 *   whose `reference_number` is a PaymentIntent id (`pi_…`) — manual/imported CHECK,
 *   WIRE, CASH payments earn the operator nothing and are excluded.
 *
 * NEEDS CENTRAL: persist the realized fee (`app_fee_cents`) on customer_payments at
 * apply time so this report reads the booked fee directly and stays exact even if a
 * merchant's schedule is re-versioned after a payment. See the module report.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeFee,
  scheduleFromRow,
  DEFAULT_FEE_SCHEDULE,
  type MerchantFeeSchedule,
  type FeeMethod,
} from '@/lib/money/fees';

export interface FeeRevenuePeriod {
  from: string | null; // inclusive YYYY-MM-DD, or null for open start
  to: string | null; // inclusive YYYY-MM-DD, or null for open end
}

export interface FeeRevenueTotals {
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number; // fee / gross, in basis points (100 bps = 1.00%)
}

export interface TenantBreakdown {
  orgId: string;
  orgName: string;
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number;
}

export interface RailBreakdown {
  rail: FeeMethod; // 'CARD' | 'ACH'
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number;
}

export interface TrendPoint {
  month: string; // YYYY-MM
  feeCents: number;
  grossCents: number;
  paymentCount: number;
}

export interface FeeRevenueReport {
  totals: FeeRevenueTotals;
  byTenant: TenantBreakdown[];
  byRail: RailBreakdown[];
  trend: TrendPoint[];
  meta: {
    from: string | null;
    to: string | null;
    tenantCount: number;
    feeSource: 'derived_from_schedule';
    feePersisted: false;
    generatedAt: string;
  };
}

interface PaymentRow {
  id: string;
  org_id: string;
  payment_date: string; // YYYY-MM-DD
  amount_cents: number | string;
  payment_method: string | null;
  reference_number: string | null;
}

interface ScheduleRow {
  org_id: string;
  ach_fee_bps: number;
  ach_fee_cap_cents: number | string | null;
  ach_fee_min_cents: number | string | null;
  card_fee_bps: number;
  card_fee_cap_cents: number | string | null;
  card_fee_min_cents: number | string | null;
  effective_from: string;
  effective_to: string | null;
}

const PAGE = 1000;

function takeRateBps(feeCents: number, grossCents: number): number {
  return grossCents > 0 ? Math.round((feeCents / grossCents) * 10000) : 0;
}

/** CREDIT_CARD → CARD, ACH → ACH; anything else can't be priced as a rail. */
function railOf(method: string | null): FeeMethod | null {
  if (method === 'CREDIT_CARD') return 'CARD';
  if (method === 'ACH') return 'ACH';
  return null;
}

/**
 * Pick the merchant's fee schedule that was IN FORCE on `paymentDate`, from the
 * org's versioned rows (newest-first is fine — we scan for the covering row).
 * Falls back to the platform default when the merchant has no schedule that day.
 */
function scheduleFor(rows: ScheduleRow[] | undefined, paymentDate: string): MerchantFeeSchedule {
  if (!rows || rows.length === 0) return DEFAULT_FEE_SCHEDULE;
  const t = Date.parse(paymentDate);
  for (const r of rows) {
    const from = Date.parse(r.effective_from);
    const to = r.effective_to ? Date.parse(r.effective_to) : Number.POSITIVE_INFINITY;
    if (t >= from && t < to) return scheduleFromRow(r);
  }
  // No covering version (e.g. payment predates the first schedule) → default.
  return DEFAULT_FEE_SCHEDULE;
}

/** Fetch every Stripe-processed payment in the window, paging past the 1k cap. */
async function fetchStripePayments(
  db: SupabaseClient,
  period: FeeRevenuePeriod,
): Promise<PaymentRow[]> {
  const out: PaymentRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from('customer_payments')
      .select('id, org_id, payment_date, amount_cents, payment_method, reference_number')
      .like('reference_number', 'pi_%')
      .order('payment_date', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (period.from) q = q.gte('payment_date', period.from);
    if (period.to) q = q.lte('payment_date', period.to);

    const { data, error } = await q;
    if (error) throw new Error(`customer_payments read failed: ${error.message}`);
    const rows = (data ?? []) as PaymentRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Build the full cross-tenant fee-revenue report for a period. `db` MUST be an
 * admin (service-role) client — this is a legitimate cross-tenant platform view.
 * The route gates it to platform staff before calling in.
 */
export async function computeFeeRevenue(
  db: SupabaseClient,
  period: FeeRevenuePeriod,
): Promise<FeeRevenueReport> {
  const [payments, schedulesRes, orgsRes] = await Promise.all([
    fetchStripePayments(db, period),
    db
      .schema('core')
      .from('merchant_fee_schedules')
      .select(
        'org_id, ach_fee_bps, ach_fee_cap_cents, ach_fee_min_cents, card_fee_bps, card_fee_cap_cents, card_fee_min_cents, effective_from, effective_to',
      )
      .order('effective_from', { ascending: false }),
    db.schema('core').from('organizations').select('id, name'),
  ]);

  if (schedulesRes.error) throw new Error(`fee schedules read failed: ${schedulesRes.error.message}`);
  if (orgsRes.error) throw new Error(`organizations read failed: ${orgsRes.error.message}`);

  // Index schedules by org (each org's versions, newest-first from the query).
  const schedulesByOrg = new Map<string, ScheduleRow[]>();
  for (const row of (schedulesRes.data ?? []) as ScheduleRow[]) {
    const list = schedulesByOrg.get(row.org_id) ?? [];
    list.push(row);
    schedulesByOrg.set(row.org_id, list);
  }
  const orgName = new Map<string, string>();
  for (const o of (orgsRes.data ?? []) as { id: string; name: string }[]) orgName.set(o.id, o.name);

  const totals: FeeRevenueTotals = { feeCents: 0, grossCents: 0, paymentCount: 0, takeRateBps: 0 };
  const tenants = new Map<string, TenantBreakdown>();
  const rails = new Map<FeeMethod, RailBreakdown>();
  const months = new Map<string, TrendPoint>();

  for (const p of payments) {
    const rail = railOf(p.payment_method);
    if (!rail) continue; // not a card/ACH rail — can't be priced as a platform fee
    const base = Number(p.amount_cents);
    if (!Number.isFinite(base) || base <= 0) continue;

    const schedule = scheduleFor(schedulesByOrg.get(p.org_id), p.payment_date);
    const fee = computeFee(schedule, rail, base);

    // Totals
    totals.feeCents += fee;
    totals.grossCents += base;
    totals.paymentCount += 1;

    // By tenant
    const t =
      tenants.get(p.org_id) ??
      {
        orgId: p.org_id,
        orgName: orgName.get(p.org_id) ?? 'Unknown tenant',
        feeCents: 0,
        grossCents: 0,
        paymentCount: 0,
        takeRateBps: 0,
      };
    t.feeCents += fee;
    t.grossCents += base;
    t.paymentCount += 1;
    tenants.set(p.org_id, t);

    // By rail
    const r =
      rails.get(rail) ?? { rail, feeCents: 0, grossCents: 0, paymentCount: 0, takeRateBps: 0 };
    r.feeCents += fee;
    r.grossCents += base;
    r.paymentCount += 1;
    rails.set(rail, r);

    // Trend (by calendar month)
    const month = p.payment_date.slice(0, 7); // YYYY-MM
    const m = months.get(month) ?? { month, feeCents: 0, grossCents: 0, paymentCount: 0 };
    m.feeCents += fee;
    m.grossCents += base;
    m.paymentCount += 1;
    months.set(month, m);
  }

  totals.takeRateBps = takeRateBps(totals.feeCents, totals.grossCents);
  const byTenant = [...tenants.values()]
    .map((t) => ({ ...t, takeRateBps: takeRateBps(t.feeCents, t.grossCents) }))
    .sort((a, b) => b.feeCents - a.feeCents);
  const byRail = [...rails.values()]
    .map((r) => ({ ...r, takeRateBps: takeRateBps(r.feeCents, r.grossCents) }))
    .sort((a, b) => b.feeCents - a.feeCents);
  const trend = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    totals,
    byTenant,
    byRail,
    trend,
    meta: {
      from: period.from,
      to: period.to,
      tenantCount: byTenant.length,
      feeSource: 'derived_from_schedule',
      feePersisted: false,
      generatedAt: new Date().toISOString(),
    },
  };
}
