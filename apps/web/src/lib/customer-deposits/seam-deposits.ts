/**
 * Customer deposits that arrive as a REQUEST from Projects (JOB_DEPOSIT_REQUEST,
 * migration 173) — the same deposits subledger as the receipt-first flow in
 * ./service.ts, entered from the billing side:
 *
 *   • Deposit invoice : DR Accounts Receivable / CR Customer Deposits (2420)
 *       (posted by the standard invoice creator; this file records the subledger row
 *        so subledger ⇄ 2420 keeps tying — computeTieOut is unchanged)
 *   • Customer pays the deposit invoice : the normal receipt (DR Cash / CR AR)
 *   • Final invoice   : the EXISTING apply flow (applyDeposit: DR 2420 / CR AR)
 *
 * Only the COLLECTED part of a requested deposit is applied at the final invoice: an
 * unpaid deposit invoice stays open on its own and the deposit stays HELD (a person can
 * still apply it from the deposits screen).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { applyDeposit, remainingCents, type DepositRow } from './service';
import { isUniqueViolation } from '@/lib/events/claim';
import { scopedWriter } from '@/lib/db/scoped-writer';

type DB = SupabaseClient;

const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0);

export interface BilledDepositInput {
  orgId: string;
  actor: string | null;
  locationId: string;
  customerId: string;
  jobId: string | null;
  depositDate: string;
  amountCents: number;
  memo: string | null;
  /** Emitter business key (unique per org, mig 173). */
  sourceRef: string;
  /** The deposit invoice and its DR AR / CR 2420 entry. */
  invoiceId: string;
  glEntryId: string;
}

/**
 * Record the subledger row for a billed deposit (status HELD, journal_entry_id = the
 * deposit invoice's entry). Idempotent on source_ref: a second call returns the row
 * that already exists.
 */
export async function recordBilledDeposit(db: DB, input: BilledDepositInput): Promise<{ id: string; created: boolean }> {
  const existing = await findDepositBySourceRef(db, input.orgId, input.sourceRef);
  if (existing) return { id: existing.id, created: false };
  // customer_deposits is SELECT-only for members (migration 176). The seam drains hand in
  // the service role; `scopedWriter` keeps any other caller on the checked path.
  const w = await scopedWriter(db, input.orgId, [input.locationId]);
  const { data, error } = await w
    .from('customer_deposits')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      customer_id: input.customerId,
      job_id: input.jobId,
      deposit_date: input.depositDate,
      amount_cents: input.amountCents,
      status: 'HELD',
      currency: 'USD',
      journal_entry_id: input.glEntryId,
      deposit_invoice_id: input.invoiceId,
      source_ref: input.sourceRef,
      memo: input.memo,
      created_by: input.actor,
    })
    .select('id')
    .single();
  if (error && isUniqueViolation(error)) {
    const again = await findDepositBySourceRef(db, input.orgId, input.sourceRef);
    if (again) return { id: again.id, created: false };
  }
  if (error || !data) throw new Error(`Deposit subledger insert failed: ${error?.message ?? 'unknown'}`);
  return { id: (data as { id: string }).id, created: true };
}

export async function findDepositBySourceRef(db: DB, orgId: string, sourceRef: string): Promise<{ id: string; deposit_invoice_id: string | null } | null> {
  const { data } = await db
    .from('customer_deposits')
    .select('id, deposit_invoice_id')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .maybeSingle();
  return (data as { id: string; deposit_invoice_id: string | null } | null) ?? null;
}

export interface AppliedSeamDeposit {
  deposit_id: string;
  application_id: string;
  amount_cents: number;
  gl_entry_id: string;
}

/**
 * Apply the job's requested (source_ref) deposits to its final invoice through the
 * existing apply flow, oldest first, limited to what was COLLECTED on each deposit
 * invoice and to the final invoice's open balance. Never throws for one deposit — a
 * failure is returned in `errors` (the final invoice is already booked).
 */
export async function applySeamDepositsToFinalInvoice(
  db: DB,
  args: { orgId: string; actor: string | null; invoiceId: string; jobId: string; customerId: string; locationId: string },
): Promise<{ applied: AppliedSeamDeposit[]; errors: string[] }> {
  const applied: AppliedSeamDeposit[] = [];
  const errors: string[] = [];

  const { data: deps } = await db
    .from('customer_deposits')
    .select('*')
    .eq('org_id', args.orgId)
    .eq('job_id', args.jobId)
    .eq('customer_id', args.customerId)
    .eq('location_id', args.locationId)
    .in('status', ['HELD', 'PARTIALLY_APPLIED'])
    .not('source_ref', 'is', null)
    .order('deposit_date', { ascending: true });

  for (const raw of (deps ?? []) as Record<string, unknown>[]) {
    const d = {
      id: String(raw.id),
      amount_cents: num(raw.amount_cents),
      applied_cents: num(raw.applied_cents),
      refunded_cents: num(raw.refunded_cents),
      deposit_invoice_id: (raw.deposit_invoice_id as string | null) ?? null,
    } satisfies Pick<DepositRow, 'id' | 'amount_cents' | 'applied_cents' | 'refunded_cents'> & { deposit_invoice_id: string | null };

    let available = remainingCents(d);
    if (d.deposit_invoice_id) {
      const { data: depInv } = await db.from('invoices').select('amount_paid_cents')
        .eq('org_id', args.orgId).eq('id', d.deposit_invoice_id).maybeSingle();
      const collected = num((depInv as { amount_paid_cents?: unknown } | null)?.amount_paid_cents);
      available = Math.min(available, Math.max(0, collected - d.applied_cents - d.refunded_cents));
    }
    if (available <= 0) continue;

    const { data: inv } = await db.from('invoices').select('balance_cents, status')
      .eq('org_id', args.orgId).eq('id', args.invoiceId).maybeSingle();
    const open = num((inv as { balance_cents?: unknown } | null)?.balance_cents);
    if (open <= 0) break;

    const amount = Math.min(available, open);
    try {
      const r = await applyDeposit(db, { orgId: args.orgId, actor: args.actor, depositId: d.id, invoiceId: args.invoiceId, amountCents: amount });
      applied.push({ deposit_id: d.id, application_id: r.application_id, amount_cents: amount, gl_entry_id: r.gl_entry_id });
    } catch (e) {
      errors.push(`deposit ${d.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, errors };
}
