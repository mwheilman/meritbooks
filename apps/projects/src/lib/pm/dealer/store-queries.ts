import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import { customerNames, vendorNames } from '@/lib/pm/ops/scope';
import {
  OUTBOX_QUEUE_COLS, RENTAL_BILLING_COLS, RENTAL_CONTRACT_COLS, RENTAL_RATE_COLS, RENTAL_UTIL_COLS, WARRANTY_OUTSTANDING_COLS,
  type BooksOutcome, type OutboxQueueRow, type RentalBillingRow, type RentalContractRow, type RentalRateRow, type RentalUtilRow, type SettledClaim,
  type WarrantyClaimStatus, type WarrantyOutstandingRow,
} from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

// ---------------------------------------------------------------- rentals
export interface FleetUnit extends RentalUtilRow {
  model_year: number | null;
  category: string | null;
  meter_reading: number | null;
}

export interface RentalBoard {
  fleet: FleetUnit[];
  contracts: RentalContractRow[];
  billings: RentalBillingRow[];
  rates: RentalRateRow[];
  customers: Record<string, string>;
}

/** The fleet (pm.v_rental_utilization), open and recent contracts, their bills, and the rate card. */
export async function loadRentals(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<RentalBoard> {
  if (!companyIds.length) return { fleet: [], contracts: [], billings: [], rates: [], customers: {} };
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [util, contracts, rates] = await Promise.all([
    rows<RentalUtilRow>(await pm(db).from('v_rental_utilization').select(RENTAL_UTIL_COLS).in('location_id', [...companyIds]).limit(1000), 'rental fleet'),
    rows<RentalContractRow>(
      await pm(db).from('rental_contracts').select(RENTAL_CONTRACT_COLS).in('location_id', [...companyIds])
        .or(`status.in.(RESERVED,OUT,RETURNED),updated_at.gte."${since}"`).order('created_at', { ascending: false }).limit(1000),
      'rental contracts',
    ),
    rows<RentalRateRow>(await pm(db).from('rental_rates').select(RENTAL_RATE_COLS).in('location_id', [...companyIds]).order('created_at', { ascending: false }), 'rental rates'),
  ]);
  const unitIds = util.map((u) => u.unit_id);
  const extra = unitIds.length
    ? rows<{ id: string; model_year: number | null; category: string | null; meter_reading: number | null }>(await pm(db).from('assets').select('id, model_year, category, meter_reading').in('id', unitIds), 'fleet units')
    : [];
  const ex = new Map(extra.map((e) => [e.id, e]));
  const ids = contracts.map((c) => c.id);
  const billings = ids.length
    ? rows<RentalBillingRow>(await pm(db).from('rental_billings').select(RENTAL_BILLING_COLS).in('contract_id', ids.slice(0, 1000)).order('created_at', { ascending: false }), 'rental bills')
    : [];
  const n = (v: number | null | undefined) => (v == null ? null : Number(v));
  return {
    fleet: util.map((u) => ({
      ...u, available_days: Number(u.available_days), on_rent_days: Number(u.on_rent_days), billed_90d_cents: Number(u.billed_90d_cents),
      model_year: ex.get(u.unit_id)?.model_year ?? null, category: ex.get(u.unit_id)?.category ?? null, meter_reading: n(ex.get(u.unit_id)?.meter_reading),
    })),
    contracts: contracts.map((c) => ({
      ...c, rate_day_cents: n(c.rate_day_cents), rate_week_cents: n(c.rate_week_cents), rate_month_cents: n(c.rate_month_cents),
      damage_waiver_pct: n(c.damage_waiver_pct), meter_out: n(c.meter_out), meter_in: n(c.meter_in),
      damage_cents: Number(c.damage_cents), fuel_cents: Number(c.fuel_cents), cleaning_cents: Number(c.cleaning_cents), delivery_cents: Number(c.delivery_cents),
    })),
    billings: billings.map((b) => ({ ...b, rental_cents: Number(b.rental_cents), damage_waiver_cents: Number(b.damage_waiver_cents), fees_cents: Number(b.fees_cents), total_cents: Number(b.total_cents) })),
    rates: rates.map((r) => ({ ...r, day_cents: n(r.day_cents), week_cents: n(r.week_cents), month_cents: n(r.month_cents), damage_waiver_pct: n(r.damage_waiver_pct) })),
    customers: await customerNames(db, contracts.map((c) => c.customer_id)),
  };
}

// ---------------------------------------------------------------- warranty
export interface WarrantyBoard {
  open: WarrantyOutstandingRow[];
  settled: SettledClaim[];
  customers: Record<string, string>;
  vendors: Record<string, string>;
}

/** Claims the manufacturer still owes (pm.v_warranty_outstanding) and the last 90 days Merit Books settled. */
export async function loadWarranty(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<WarrantyBoard> {
  if (!companyIds.length) return { open: [], settled: [], customers: {}, vendors: {} };
  const open = rows<WarrantyOutstandingRow>(
    await pm(db).from('v_warranty_outstanding').select(WARRANTY_OUTSTANDING_COLS).in('location_id', [...companyIds]).order('filing_deadline', { nullsFirst: false }).limit(1000),
    'open warranty claims',
  ).map((c) => ({
    ...c, claimed_cents: Number(c.claimed_cents), approved_cents: c.approved_cents == null ? null : Number(c.approved_cents), paid_cents: Number(c.paid_cents),
    short_paid_cents: Number(c.short_paid_cents), outstanding_cents: Number(c.outstanding_cents), days_outstanding: c.days_outstanding == null ? null : Number(c.days_outstanding),
  }));
  // settled by Books: claims carry books_outcome; their work orders give the company and the RO number
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const settledRows = rows<{
    id: string; claim_number: string | null; status: WarrantyClaimStatus; work_order_id: string; payer_customer_id: string; claimed_cents: number; paid_cents: number;
    short_paid_cents: number; books_outcome: BooksOutcome; books_paid_on: string | null; books_credit_ref: string | null; decision_reason: string | null; updated_at: string;
  }>(
    await pm(db).from('warranty_claims').select('id, claim_number, status, work_order_id, payer_customer_id, claimed_cents, paid_cents, short_paid_cents, books_outcome, books_paid_on, books_credit_ref, decision_reason, updated_at')
      .not('books_outcome', 'is', null).gte('updated_at', since).order('updated_at', { ascending: false }).limit(500),
    'settled warranty claims',
  );
  const woIds = [...new Set(settledRows.map((c) => c.work_order_id))];
  const wos = woIds.length ? rows<{ id: string; number: string | null; location_id: string }>(await pm(db).from('work_orders').select('id, number, location_id').in('id', woIds), 'repair orders') : [];
  const wo = new Map(wos.map((w) => [w.id, w]));
  const settled: SettledClaim[] = settledRows
    .filter((c) => companyIds.includes(wo.get(c.work_order_id)?.location_id ?? ''))
    .map((c) => ({
      claim_id: c.id, claim_number: c.claim_number, status: c.status, work_order_id: c.work_order_id, ro_number: wo.get(c.work_order_id)?.number ?? null,
      payer_customer_id: c.payer_customer_id, claimed_cents: Number(c.claimed_cents), paid_cents: Number(c.paid_cents), short_paid_cents: Number(c.short_paid_cents),
      books_outcome: c.books_outcome, books_paid_on: c.books_paid_on, books_credit_ref: c.books_credit_ref, reason: c.decision_reason,
    }));
  const [customers, vendors] = await Promise.all([
    customerNames(db, [...open.map((c) => c.payer_customer_id), ...settled.map((c) => c.payer_customer_id)]),
    vendorNames(db, open.map((c) => c.oem_vendor_id)),
  ]);
  return { open, settled, customers, vendors };
}

// ---------------------------------------------------------------- Merit Books seam
export interface OutboxSummary {
  queue: OutboxQueueRow[];
  processed30: number;
  seamOn: boolean | null;
}

/** "Waiting on Merit Books": HELD / RELEASED / REJECTED dealer events (pm.v_dealer_outbox_queue). */
export async function loadOutbox(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<OutboxSummary> {
  if (!companyIds.length) return { queue: [], processed30: 0, seamOn: null };
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [queue, processed] = await Promise.all([
    rows<OutboxQueueRow>(await pm(db).from('v_dealer_outbox_queue').select(OUTBOX_QUEUE_COLS).in('location_id', [...companyIds]).order('seq', { ascending: false }).limit(500), 'dealer events'),
    pm(db).from('dealer_outbox').select('id', { count: 'exact', head: true }).in('location_id', [...companyIds]).eq('status', 'PROCESSED').gte('acked_at', since),
  ]);
  // A RELEASED or PROCESSED row in the last 30 days means Books is taking dealer events.
  const released = queue.some((q) => q.status === 'RELEASED' || q.status === 'REJECTED') || (processed.count ?? 0) > 0;
  const held = queue.some((q) => q.status === 'HELD');
  return { queue, processed30: processed.count ?? 0, seamOn: released ? true : held ? false : null };
}
