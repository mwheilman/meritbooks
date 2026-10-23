/**
 * Late fees / finance charges (FPB-invoices D6.3; migration 184).
 *
 * POLICY (public.late_fee_policies, tenant row or per company): FLAT amount or a monthly
 * percentage (basis points, max 10%/month), grace days, ONCE or MONTHLY, a minimum and a
 * maximum per assessment, an optional lifetime cap per invoice, a minimum balance, which
 * customers (all · only these · all but these), and the income account the fee credits.
 *
 * PROPOSE → APPROVE. The nightly `ar.late_fees` job only writes PROPOSED rows
 * (public.late_fee_assessments, UNIQUE per invoice + period — it can never double-assess).
 * Nothing reaches the customer or the GL until a person approves: approval bundles the
 * selected fees per company + customer into ONE finance-charge invoice (createInvoice —
 * the same code a hand-keyed invoice uses — posted to AR, credited to the policy's income
 * account). Rejected fees are never re-proposed for that period.
 *
 * NEVER COMPOUNDING: the base is the ORIGINAL invoice's open balance. Fees live on their
 * own finance-charge invoices (invoice_type 'Finance charge', source_ref 'late-fees:…'),
 * which are never themselves assessed. Disputed invoices are never assessed.
 *
 * `computeLateFee` is pure and unit-tested; the rest is thin I/O.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { scopedWriter } from '@/lib/db/scoped-writer';

export const FINANCE_CHARGE_INVOICE_TYPE = 'Finance charge';
export const LATE_FEE_SOURCE_PREFIX = 'late-fees:';

export type LateFeeMethod = 'FLAT' | 'PERCENT_MONTHLY';
export type LateFeeFrequency = 'ONCE' | 'MONTHLY';
export type LateFeeApplyTo = 'ALL' | 'INCLUDE' | 'EXCLUDE';

export interface LateFeePolicy {
  enabled: boolean;
  method: LateFeeMethod;
  flatFeeCents: number;
  /** Monthly rate in basis points (150 = 1.5% a month). */
  rateBps: number;
  graceDays: number;
  frequency: LateFeeFrequency;
  minFeeCents: number;
  maxFeeCents: number | null;
  maxTotalPerInvoiceCents: number | null;
  minBalanceCents: number;
  applyTo: LateFeeApplyTo;
  customerIds: string[];
  incomeAccountId: string | null;
}

export const DEFAULT_LATE_FEE_POLICY: LateFeePolicy = {
  enabled: false,
  method: 'PERCENT_MONTHLY',
  flatFeeCents: 0,
  rateBps: 150,
  graceDays: 0,
  frequency: 'MONTHLY',
  minFeeCents: 0,
  maxFeeCents: null,
  maxTotalPerInvoiceCents: null,
  minBalanceCents: 0,
  applyTo: 'ALL',
  customerIds: [],
  incomeAccountId: null,
};

export const lateFeePolicyInputSchema = z
  .object({
    location_id: z.string().uuid().nullable().default(null),
    enabled: z.boolean(),
    method: z.enum(['FLAT', 'PERCENT_MONTHLY']),
    flat_fee_cents: z.number().int().min(0).max(100_000_00).default(0),
    rate_bps: z.number().int().min(0).max(1000).default(150),
    grace_days: z.number().int().min(0).max(365).default(0),
    frequency: z.enum(['ONCE', 'MONTHLY']).default('MONTHLY'),
    min_fee_cents: z.number().int().min(0).max(100_000_00).default(0),
    max_fee_cents: z.number().int().min(0).max(100_000_000_00).nullable().default(null),
    max_total_per_invoice_cents: z.number().int().min(1).max(100_000_000_00).nullable().default(null),
    min_balance_cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    apply_to: z.enum(['ALL', 'INCLUDE', 'EXCLUDE']).default('ALL'),
    customer_ids: z.array(z.string().uuid()).max(500).default([]),
    income_account_id: z.string().uuid().nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.enabled && v.method === 'FLAT' && v.flat_fee_cents <= 0) ctx.addIssue({ code: 'custom', path: ['flat_fee_cents'], message: 'Enter the flat fee.' });
    if (v.enabled && v.method === 'PERCENT_MONTHLY' && v.rate_bps <= 0) ctx.addIssue({ code: 'custom', path: ['rate_bps'], message: 'Enter the monthly rate.' });
    if (v.max_fee_cents != null && v.max_fee_cents < v.min_fee_cents) ctx.addIssue({ code: 'custom', path: ['max_fee_cents'], message: 'The maximum is below the minimum.' });
    if (v.enabled && !v.income_account_id) ctx.addIssue({ code: 'custom', path: ['income_account_id'], message: 'Pick the income account late fees are credited to.' });
    if (v.apply_to !== 'ALL' && v.customer_ids.length === 0) ctx.addIssue({ code: 'custom', path: ['customer_ids'], message: 'Pick at least one customer.' });
  });

export type LateFeePolicyInput = z.infer<typeof lateFeePolicyInputSchema>;

export interface LateFeePolicyRow {
  location_id: string | null;
  enabled: boolean;
  method: string;
  flat_fee_cents: number | string;
  rate_bps: number;
  grace_days: number;
  frequency: string;
  min_fee_cents: number | string;
  max_fee_cents: number | string | null;
  max_total_per_invoice_cents: number | string | null;
  min_balance_cents: number | string;
  apply_to: string;
  customer_ids: string[] | null;
  income_account_id: string | null;
}

const n = (v: number | string | null | undefined): number => Number(v ?? 0);
const nn = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function lateFeePolicyFromRow(r: LateFeePolicyRow): LateFeePolicy {
  return {
    enabled: !!r.enabled,
    method: r.method === 'FLAT' ? 'FLAT' : 'PERCENT_MONTHLY',
    flatFeeCents: n(r.flat_fee_cents),
    rateBps: Number(r.rate_bps ?? 0),
    graceDays: Number(r.grace_days ?? 0),
    frequency: r.frequency === 'ONCE' ? 'ONCE' : 'MONTHLY',
    minFeeCents: n(r.min_fee_cents),
    maxFeeCents: nn(r.max_fee_cents),
    maxTotalPerInvoiceCents: nn(r.max_total_per_invoice_cents),
    minBalanceCents: n(r.min_balance_cents),
    applyTo: r.apply_to === 'INCLUDE' || r.apply_to === 'EXCLUDE' ? r.apply_to : 'ALL',
    customerIds: r.customer_ids ?? [],
    incomeAccountId: r.income_account_id,
  };
}

export function resolveLateFeePolicy(rows: ReadonlyArray<LateFeePolicyRow>, locationId: string | null): LateFeePolicy & { source: 'company' | 'tenant' | 'default' } {
  const own = locationId ? rows.find((r) => r.location_id === locationId) : undefined;
  if (own) return { ...lateFeePolicyFromRow(own), source: 'company' };
  const tenant = rows.find((r) => r.location_id === null);
  if (tenant) return { ...lateFeePolicyFromRow(tenant), source: 'tenant' };
  return { ...DEFAULT_LATE_FEE_POLICY, source: 'default' };
}

// ── the math (pure) ──────────────────────────────────────────────────────────

export interface LateFeeInvoiceFacts {
  customerId: string | null;
  balanceCents: number;
  daysPastDue: number;
  disputed: boolean;
  /** A finance-charge invoice itself — never assessed (no compounding). */
  isFinanceCharge: boolean;
  /** Σ fees already assessed on this invoice (PROPOSED + APPROVED). */
  assessedToDateCents: number;
  /** Periods that already have an assessment (any status) — UNIQUE per period. */
  assessedPeriods: ReadonlySet<string>;
}

export type LateFeeOutcome =
  | { fee: true; periodKey: string; baseCents: number; feeCents: number; capped: boolean }
  | { fee: false; reason: 'disabled' | 'not_eligible' | 'in_grace' | 'below_minimum' | 'already_assessed' | 'cap_reached' | 'zero' };

/** Round-half-up integer cents of `cents × bps / 10 000` (no floating point). */
export function bpsOf(cents: number, bps: number): number {
  if (cents <= 0 || bps <= 0) return 0;
  return Math.floor((Math.trunc(cents) * Math.trunc(bps) + 5000) / 10000);
}

export function customerEligible(p: Pick<LateFeePolicy, 'applyTo' | 'customerIds'>, customerId: string | null): boolean {
  if (p.applyTo === 'ALL') return true;
  const listed = !!customerId && p.customerIds.includes(customerId);
  return p.applyTo === 'INCLUDE' ? listed : !listed;
}

/** The fee (if any) an invoice owes at `asOf` (YYYY-MM-DD) under `p`. */
export function computeLateFee(p: LateFeePolicy, f: LateFeeInvoiceFacts, asOf: string): LateFeeOutcome {
  if (!p.enabled) return { fee: false, reason: 'disabled' };
  if (f.isFinanceCharge || f.disputed || !customerEligible(p, f.customerId)) return { fee: false, reason: 'not_eligible' };
  if (f.daysPastDue <= p.graceDays) return { fee: false, reason: 'in_grace' };
  if (f.balanceCents <= 0 || f.balanceCents < p.minBalanceCents) return { fee: false, reason: 'below_minimum' };

  const periodKey = p.frequency === 'ONCE' ? 'ONCE' : asOf.slice(0, 7);
  if (f.assessedPeriods.has(periodKey) || (p.frequency === 'ONCE' && f.assessedPeriods.size > 0)) {
    return { fee: false, reason: 'already_assessed' };
  }

  let fee = p.method === 'FLAT' ? Math.trunc(p.flatFeeCents) : bpsOf(f.balanceCents, p.rateBps);
  let capped = false;
  if (fee < p.minFeeCents) fee = Math.trunc(p.minFeeCents);
  if (p.maxFeeCents != null && fee > p.maxFeeCents) {
    fee = Math.trunc(p.maxFeeCents);
    capped = true;
  }
  if (p.maxTotalPerInvoiceCents != null) {
    const room = Math.trunc(p.maxTotalPerInvoiceCents) - Math.max(0, f.assessedToDateCents);
    if (room <= 0) return { fee: false, reason: 'cap_reached' };
    if (fee > room) {
      fee = room;
      capped = true;
    }
  }
  if (fee <= 0) return { fee: false, reason: 'zero' };
  return { fee: true, periodKey, baseCents: Math.trunc(f.balanceCents), feeCents: fee, capped };
}

export function isFinanceChargeInvoice(inv: { invoice_type?: string | null; source_ref?: string | null }): boolean {
  return inv.invoice_type === FINANCE_CHARGE_INVOICE_TYPE || (inv.source_ref ?? '').startsWith(LATE_FEE_SOURCE_PREFIX);
}

// ── approval → finance-charge invoice ────────────────────────────────────────

export interface AssessmentRow {
  id: string;
  location_id: string;
  invoice_id: string;
  customer_id: string | null;
  period_key: string;
  fee_cents: number | string;
  base_cents: number | string;
  status: string;
  days_past_due: number;
}

export interface LateFeeInvoiceState {
  id: string;
  invoice_number: string;
  status: string;
  balance_cents: number | string;
  disputed_at: string | null;
}

const NO_FEE_STATUSES = new Set(['DRAFT', 'PAID', 'VOIDED', 'WRITTEN_OFF', 'CREDITED']);

/** Pure: why a proposed fee may NOT be approved against this invoice now (null = OK). */
export function lateFeeApprovalBlock(inv: LateFeeInvoiceState | undefined): string | null {
  if (!inv) return 'the invoice no longer exists.';
  if (inv.disputed_at) return 'the invoice is disputed.';
  if (NO_FEE_STATUSES.has(inv.status)) return `the invoice is ${inv.status.toLowerCase().replace('_', ' ')}.`;
  if (Number(inv.balance_cents) <= 0) return 'the invoice is paid.';
  return null;
}

export interface DecideResult {
  approved: number;
  rejected: number;
  invoices: Array<{ invoice_id: string; invoice_number: string; total_cents: number; fees: number }>;
  errors: string[];
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Approve or reject PROPOSED fees. `db` is the caller's RLS client (rows are read through
 * it, so only fees in the caller's org + client scope are touched); writes go through the
 * scoped service writer. Approval claims each group first (PROPOSED → APPROVED, optimistic),
 * then creates the finance-charge invoice; a failed invoice rolls its group back to PROPOSED.
 */
export async function decideLateFees(
  db: SupabaseClient,
  orgId: string,
  args: { ids: string[]; action: 'approve' | 'reject'; actor: string; note?: string | null; today: string },
): Promise<DecideResult> {
  const out: DecideResult = { approved: 0, rejected: 0, invoices: [], errors: [] };
  const ids = Array.from(new Set(args.ids)).slice(0, 500);
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from('late_fee_assessments')
    .select('id, location_id, invoice_id, customer_id, period_key, fee_cents, base_cents, status, days_past_due')
    .eq('org_id', orgId)
    .in('id', ids)
    .eq('status', 'PROPOSED');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AssessmentRow[];
  const nowIso = new Date().toISOString();
  const note = args.note?.trim() ? args.note.trim().slice(0, 500) : null;

  if (args.action === 'reject') {
    const byLoc = new Map<string, string[]>();
    for (const r of rows) byLoc.set(r.location_id, [...(byLoc.get(r.location_id) ?? []), r.id]);
    for (const [loc, locIds] of byLoc) {
      const w = await scopedWriter(db, orgId, [loc]);
      const { data: upd, error: uErr } = await w
        .from('late_fee_assessments')
        .update({ status: 'REJECTED', decided_by: args.actor, decided_at: nowIso, decision_note: note, updated_at: nowIso })
        .eq('org_id', orgId)
        .in('id', locIds)
        .eq('status', 'PROPOSED')
        .select('id');
      if (uErr) out.errors.push(uErr.message);
      else out.rejected += (upd ?? []).length;
    }
    return out;
  }

  // Load the policies (income account) + the original invoice numbers for the line text.
  const [{ data: polData }, { data: invData, error: invErr }] = await Promise.all([
    db.from('late_fee_policies').select('location_id, enabled, method, flat_fee_cents, rate_bps, grace_days, frequency, min_fee_cents, max_fee_cents, max_total_per_invoice_cents, min_balance_cents, apply_to, customer_ids, income_account_id').eq('org_id', orgId),
    db.from('invoices').select('id, invoice_number, status, balance_cents, disputed_at').eq('org_id', orgId).in('id', Array.from(new Set(rows.map((r) => r.invoice_id)))),
  ]);
  if (invErr) throw new Error(invErr.message);
  const policies = (polData ?? []) as LateFeePolicyRow[];
  const invById = new Map(((invData ?? []) as LateFeeInvoiceState[]).map((r) => [r.id, r]));
  const invNo = new Map(Array.from(invById.values()).map((r) => [r.id, r.invoice_number]));

  // One finance-charge invoice per company + customer.
  const groups = new Map<string, AssessmentRow[]>();
  for (const r of rows) {
    // Re-check the invoice NOW: it may have been disputed, paid or voided since the fee
    // was proposed. Such fees are skipped (left PROPOSED, reported) — never charged.
    const why = lateFeeApprovalBlock(invById.get(r.invoice_id));
    if (why) {
      out.errors.push(`Fee on ${invNo.get(r.invoice_id) ?? r.invoice_id.slice(0, 8)} skipped: ${why}`);
      continue;
    }
    if (!r.customer_id) {
      out.errors.push(`Fee ${r.id.slice(0, 8)}: the invoice has no customer.`);
      continue;
    }
    const k = `${r.location_id}|${r.customer_id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  for (const [, group] of groups) {
    const loc = group[0].location_id;
    const customerId = group[0].customer_id as string;
    const policy = resolveLateFeePolicy(policies, loc);
    if (!policy.incomeAccountId) {
      out.errors.push('Set the late-fee income account in Settings → Automation → Late fees before approving.');
      continue;
    }
    const w = await scopedWriter(db, orgId, [loc]);
    const groupIds = group.map((g) => g.id).sort();
    const { data: claimed, error: cErr } = await w
      .from('late_fee_assessments')
      .update({ status: 'APPROVED', decided_by: args.actor, decided_at: nowIso, decision_note: note, updated_at: nowIso })
      .eq('org_id', orgId)
      .in('id', groupIds)
      .eq('status', 'PROPOSED')
      .select('id');
    if (cErr) {
      out.errors.push(cErr.message);
      continue;
    }
    const claimedIds = new Set(((claimed ?? []) as Array<{ id: string }>).map((c) => c.id));
    const mine = group.filter((g) => claimedIds.has(g.id));
    if (mine.length === 0) continue;

    const outcome = await createInvoice(db, {
      orgId,
      actor: args.actor,
      input: {
        location_id: loc,
        customer_id: customerId,
        invoice_date: args.today,
        due_date: addDays(args.today, 15),
        memo: `Finance charges on overdue invoices (${mine.map((m) => invNo.get(m.invoice_id) ?? m.invoice_id.slice(0, 8)).join(', ')})`.slice(0, 1000),
        invoice_type: FINANCE_CHARGE_INVOICE_TYPE,
        post_to_gl: true,
        source: { source_ref: `${LATE_FEE_SOURCE_PREFIX}${mine.map((m) => m.id).sort().join(',')}`.slice(0, 500) },
        lines: mine.map((m) => ({
          description: `Late fee on invoice ${invNo.get(m.invoice_id) ?? ''} — ${m.period_key === 'ONCE' ? 'one-time' : m.period_key} (${m.days_past_due} days past due)`.slice(0, 500),
          account_id: policy.incomeAccountId as string,
          quantity: 1,
          unit_price_cents: Number(m.fee_cents),
        })),
      },
    });
    if (!outcome.ok) {
      await w
        .from('late_fee_assessments')
        .update({ status: 'PROPOSED', decided_by: null, decided_at: null, decision_note: null, updated_at: nowIso })
        .eq('org_id', orgId)
        .in('id', [...claimedIds]);
      out.errors.push(`Could not create the finance-charge invoice: ${outcome.error}`);
      continue;
    }
    await w
      .from('late_fee_assessments')
      .update({ finance_charge_invoice_id: outcome.result.invoice_id, updated_at: nowIso })
      .eq('org_id', orgId)
      .in('id', [...claimedIds]);
    out.approved += mine.length;
    out.invoices.push({ invoice_id: outcome.result.invoice_id, invoice_number: outcome.result.invoice_number, total_cents: outcome.result.total_cents, fees: mine.length });
  }
  return out;
}
