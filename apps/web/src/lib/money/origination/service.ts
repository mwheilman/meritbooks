/**
 * Money-out ORIGINATION service (migration 143) — DB reads/writes over the
 * payment_origination_batches / _items tables, driven by the provider seam.
 *
 * Flow: a human has already APPROVED and RELEASED a disbursement (the release path
 * posted DR A/P / CR Cash via recordBillPayment and stamped the approval RELEASED
 * with provider_correlation_id = 'bill_payment:<id>'). THIS service takes those
 * already-posted disbursements, records a rail hand-off (a batch + per-payee items),
 * submits it through the active provider (SANDBOX today), and tracks the returned
 * lifecycle.
 *
 * HARD INVARIANT (canon §3): NOTHING here posts to the GL or moves money. On a
 * RETURN the item is marked RETURNED with its ACH return code and FLAGGED — a real
 * return's reversing entry is a separate human-authorized action, never automatic.
 *
 * Idempotency:
 *  - create excludes any approval that already has an origination item, so the same
 *    posted disbursement can't be originated twice.
 *  - submit is a no-op on a batch that isn't still CREATED, so a double-submit never
 *    duplicates the rail hand-off.
 *
 * All money is bigint cents. Pass the request's RLS-scoped Supabase client — every
 * row is org-isolated by the migration-143 `org_isolation` policy.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OriginationBatchStatus,
  OriginationItemStatus,
  OriginationLine,
  OriginationProvider,
  OriginationRail,
  StatusQuery,
} from './provider';

// ── Pure helpers (DB-free, unit-tested) ──────────────────────────────────────

export interface LineSummary {
  itemCount: number;
  totalCents: number;
}

/**
 * Total + count over origination lines. Throws on a non-positive amount (a money
 * invariant mirroring the items CHECK constraint) so a bad line can never be batched.
 */
export function summarizeLines(lines: Array<{ amountCents: number }>): LineSummary {
  let totalCents = 0;
  for (const l of lines) {
    if (!Number.isFinite(l.amountCents) || l.amountCents <= 0) {
      throw new Error(`Origination line has a non-positive amount (${l.amountCents})`);
    }
    totalCents += l.amountCents;
  }
  return { itemCount: lines.length, totalCents };
}

/** Extract the posted bill_payments.id from an approval's provider_correlation_id. */
export function parseBillPaymentId(correlationId: string | null): string | null {
  if (!correlationId) return null;
  const m = /bill_payment:([0-9a-fA-F-]{8,})/.exec(correlationId);
  return m ? m[1] : null;
}

/**
 * Fold provider per-item verdicts into a single batch status. Any RETURNED →
 * RETURNED (needs a human); else any FAILED → FAILED; else all SETTLED → SETTLED;
 * otherwise still SUBMITTED (in flight).
 */
export function foldBatchStatus(itemStatuses: OriginationItemStatus[]): OriginationBatchStatus {
  if (itemStatuses.length === 0) return 'SUBMITTED';
  if (itemStatuses.some((s) => s === 'RETURNED')) return 'RETURNED';
  if (itemStatuses.some((s) => s === 'FAILED')) return 'FAILED';
  if (itemStatuses.every((s) => s === 'SETTLED')) return 'SETTLED';
  return 'SUBMITTED';
}

// ── DB shapes ────────────────────────────────────────────────────────────────

interface ReleasedApprovalRow {
  id: string;
  subject_id: string;
  amount_cents: number | null;
  provider_correlation_id: string | null;
}
interface BillRow {
  id: string;
  vendor_id: string;
  location_id: string | null;
  payment_method: string | null;
}

export interface AssembledReleasedLine {
  approvalId: string;
  billPaymentId: string | null;
  vendorId: string | null;
  locationId: string | null;
  amountCents: number;
  /** derived pay method of the underlying bill ('ACH' | 'CHECK' | other/uppercased). */
  method: string;
}

export interface AssembledReleased {
  lines: AssembledReleasedLine[];
  /** approvalIds skipped because a CHECK-method disbursement isn't rail-originated. */
  skippedChecks: string[];
  /** approvalIds skipped because they were already placed in an origination batch. */
  alreadyOriginated: string[];
}

/**
 * Load RELEASED (posted) AP disbursements that are not yet in an origination batch,
 * shaped into rail lines. Optionally restrict to specific approval ids. CHECK-method
 * disbursements are excluded from an ACH/WIRE rail (they clear as physical checks).
 */
export async function assembleReleasedDisbursements(
  db: SupabaseClient,
  opts: { approvalIds?: string[]; includeChecks?: boolean } = {},
): Promise<AssembledReleased> {
  let q = db
    .from('approvals')
    .select('id, subject_id, amount_cents, provider_correlation_id')
    .eq('kind', 'AP_DISBURSEMENT')
    .eq('subject_table', 'bills')
    .eq('status', 'RELEASED');
  if (opts.approvalIds && opts.approvalIds.length > 0) q = q.in('id', opts.approvalIds);
  const { data: apprData, error: apprErr } = await q;
  if (apprErr) throw new Error(apprErr.message);
  const approvals = (apprData ?? []) as ReleasedApprovalRow[];
  if (approvals.length === 0) return { lines: [], skippedChecks: [], alreadyOriginated: [] };

  // Idempotency: drop any approval already carried by an origination item.
  const approvalIds = approvals.map((a) => a.id);
  const { data: existingItems, error: existErr } = await db
    .from('payment_origination_items')
    .select('approval_id')
    .in('approval_id', approvalIds);
  if (existErr) throw new Error(existErr.message);
  const originated = new Set(
    ((existingItems ?? []) as Array<{ approval_id: string | null }>)
      .map((r) => r.approval_id)
      .filter((v): v is string => !!v),
  );

  const billIds = Array.from(new Set(approvals.map((a) => a.subject_id)));
  const { data: billData, error: billErr } = await db
    .from('bills')
    .select('id, vendor_id, location_id, payment_method')
    .in('id', billIds);
  if (billErr) throw new Error(billErr.message);
  const billById = new Map<string, BillRow>(((billData ?? []) as BillRow[]).map((b) => [b.id, b]));

  const lines: AssembledReleasedLine[] = [];
  const skippedChecks: string[] = [];
  const alreadyOriginated: string[] = [];
  for (const a of approvals) {
    if (originated.has(a.id)) {
      alreadyOriginated.push(a.id);
      continue;
    }
    const bill = billById.get(a.subject_id);
    const method = (bill?.payment_method ?? '').toUpperCase() || 'ACH';
    if (!opts.includeChecks && method === 'CHECK') {
      skippedChecks.push(a.id);
      continue;
    }
    const amountCents = a.amount_cents ?? 0;
    if (!amountCents || amountCents <= 0) continue; // never batch a non-positive line
    lines.push({
      approvalId: a.id,
      billPaymentId: parseBillPaymentId(a.provider_correlation_id),
      vendorId: bill?.vendor_id ?? null,
      locationId: bill?.location_id ?? null,
      amountCents,
      method,
    });
  }
  return { lines, skippedChecks, alreadyOriginated };
}

// ── Batch + item rows ────────────────────────────────────────────────────────

export interface OriginationItem {
  id: string;
  batchId: string;
  approvalId: string | null;
  billPaymentId: string | null;
  vendorId: string | null;
  amountCents: number;
  status: OriginationItemStatus;
  returnCode: string | null;
}
export interface OriginationBatch {
  id: string;
  orgId: string;
  locationId: string | null;
  provider: string;
  rail: OriginationRail;
  status: OriginationBatchStatus;
  providerBatchRef: string | null;
  totalCents: number;
  itemCount: number;
  effectiveDate: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  items: OriginationItem[];
}

interface BatchRow {
  id: string;
  org_id: string;
  location_id: string | null;
  provider: string;
  rail: OriginationRail;
  status: OriginationBatchStatus;
  provider_batch_ref: string | null;
  total_cents: number | string;
  item_count: number;
  effective_date: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  settled_at: string | null;
  created_at: string;
}
interface ItemRow {
  id: string;
  batch_id: string;
  approval_id: string | null;
  bill_payment_id: string | null;
  vendor_id: string | null;
  amount_cents: number | string;
  status: OriginationItemStatus;
  return_code: string | null;
}

function toItem(r: ItemRow): OriginationItem {
  return {
    id: r.id,
    batchId: r.batch_id,
    approvalId: r.approval_id,
    billPaymentId: r.bill_payment_id,
    vendorId: r.vendor_id,
    amountCents: Number(r.amount_cents),
    status: r.status,
    returnCode: r.return_code,
  };
}
function toBatch(r: BatchRow, items: OriginationItem[]): OriginationBatch {
  return {
    id: r.id,
    orgId: r.org_id,
    locationId: r.location_id,
    provider: r.provider,
    rail: r.rail,
    status: r.status,
    providerBatchRef: r.provider_batch_ref,
    totalCents: Number(r.total_cents),
    itemCount: r.item_count,
    effectiveDate: r.effective_date,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    settledAt: r.settled_at,
    createdAt: r.created_at,
    items,
  };
}

export class NothingToOriginateError extends Error {
  constructor() {
    super('No released disbursements available to originate.');
    this.name = 'NothingToOriginateError';
  }
}

/**
 * Create a CREATED origination batch (+ PENDING items) from already-released
 * disbursements. Idempotent at the line level (approvals already originated are
 * skipped). Throws NothingToOriginateError when no eligible line remains.
 */
export async function createOriginationBatch(
  db: SupabaseClient,
  orgId: string,
  opts: {
    provider: string;
    rail: OriginationRail;
    approvalIds?: string[];
    effectiveDate?: string | null;
    includeChecks?: boolean;
  },
): Promise<OriginationBatch> {
  const assembled = await assembleReleasedDisbursements(db, {
    approvalIds: opts.approvalIds,
    includeChecks: opts.includeChecks,
  });
  if (assembled.lines.length === 0) throw new NothingToOriginateError();

  const summary = summarizeLines(assembled.lines);
  const locationId = assembled.lines.find((l) => l.locationId)?.locationId ?? null;

  const { data: batchData, error: batchErr } = await db
    .from('payment_origination_batches')
    .insert({
      org_id: orgId,
      location_id: locationId,
      provider: opts.provider,
      rail: opts.rail,
      status: 'CREATED',
      total_cents: summary.totalCents,
      item_count: summary.itemCount,
      effective_date: opts.effectiveDate ?? null,
    })
    .select('*')
    .single();
  if (batchErr) throw new Error(batchErr.message);
  const batchRow = batchData as BatchRow;

  const itemRows = assembled.lines.map((l) => ({
    org_id: orgId,
    batch_id: batchRow.id,
    approval_id: l.approvalId,
    bill_payment_id: l.billPaymentId,
    vendor_id: l.vendorId,
    amount_cents: l.amountCents,
    status: 'PENDING' as OriginationItemStatus,
  }));
  const { data: insertedItems, error: itemErr } = await db
    .from('payment_origination_items')
    .insert(itemRows)
    .select('*');
  if (itemErr) throw new Error(itemErr.message);

  return toBatch(batchRow, ((insertedItems ?? []) as ItemRow[]).map(toItem));
}

async function loadBatch(db: SupabaseClient, orgId: string, batchId: string): Promise<OriginationBatch | null> {
  const { data: b, error: bErr } = await db
    .from('payment_origination_batches')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', batchId)
    .maybeSingle();
  if (bErr) throw new Error(bErr.message);
  if (!b) return null;
  const { data: items, error: iErr } = await db
    .from('payment_origination_items')
    .select('*')
    .eq('org_id', orgId)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true });
  if (iErr) throw new Error(iErr.message);
  return toBatch(b as BatchRow, ((items ?? []) as ItemRow[]).map(toItem));
}

export interface SubmitOutcome {
  batch: OriginationBatch;
  /** true when this call actually handed the batch to the rail (vs. an idempotent no-op). */
  submitted: boolean;
}

/**
 * Submit a CREATED batch through the provider. IDEMPOTENT: if the batch is no longer
 * CREATED (already SUBMITTED/SETTLED/RETURNED/etc.) it is returned unchanged with
 * `submitted: false` — the rail hand-off is never duplicated.
 */
export async function submitOriginationBatch(
  db: SupabaseClient,
  orgId: string,
  batchId: string,
  provider: OriginationProvider,
  actor: string,
): Promise<SubmitOutcome> {
  const batch = await loadBatch(db, orgId, batchId);
  if (!batch) throw new Error('Origination batch not found');
  if (batch.status !== 'CREATED') {
    return { batch, submitted: false }; // idempotent: already handed off.
  }

  const lines: OriginationLine[] = batch.items.map((i) => ({
    itemId: i.id,
    amountCents: i.amountCents,
    vendorId: i.vendorId,
  }));
  const result = await provider.submitBatch({
    batchId: batch.id,
    rail: batch.rail,
    effectiveDate: batch.effectiveDate,
    lines,
  });

  const submittedAt = new Date().toISOString();
  const { error: bErr } = await db
    .from('payment_origination_batches')
    .update({
      status: result.status,
      provider_batch_ref: result.providerBatchRef,
      submitted_by: actor,
      submitted_at: submittedAt,
      trace: result.trace,
      updated_at: submittedAt,
    })
    .eq('org_id', orgId)
    .eq('id', batchId)
    .eq('status', 'CREATED'); // compare-and-set so two racing submits don't both hand off
  if (bErr) throw new Error(bErr.message);

  const byItem = new Map(result.items.map((r) => [r.itemId, r]));
  for (const item of batch.items) {
    const verdict = byItem.get(item.id);
    await db
      .from('payment_origination_items')
      .update({ status: verdict?.status ?? 'SUBMITTED', updated_at: submittedAt })
      .eq('org_id', orgId)
      .eq('id', item.id);
  }

  const refreshed = await loadBatch(db, orgId, batchId);
  return { batch: refreshed ?? batch, submitted: true };
}

/**
 * Poll the provider for a SUBMITTED batch and persist the returned lifecycle. On a
 * RETURN, the item is stamped RETURNED with its ACH return code and the batch rolls
 * up to RETURNED — surfaced for a human. NOTHING is reversed in the GL here.
 */
export async function refreshOriginationBatch(
  db: SupabaseClient,
  orgId: string,
  batchId: string,
  provider: OriginationProvider,
  simulate?: StatusQuery['simulate'],
): Promise<OriginationBatch> {
  const batch = await loadBatch(db, orgId, batchId);
  if (!batch) throw new Error('Origination batch not found');
  if (batch.status === 'CREATED') {
    throw new Error('Batch has not been submitted to the rail yet');
  }
  if (!batch.providerBatchRef) throw new Error('Batch has no provider reference');

  const lines: OriginationLine[] = batch.items.map((i) => ({
    itemId: i.id,
    amountCents: i.amountCents,
    vendorId: i.vendorId,
  }));
  const status = await provider.getStatus({ providerBatchRef: batch.providerBatchRef, lines, simulate });

  const byItem = new Map(status.items.map((r) => [r.itemId, r]));
  const now = new Date().toISOString();
  const itemStatuses: OriginationItemStatus[] = [];
  for (const item of batch.items) {
    const verdict = byItem.get(item.id);
    const nextStatus = verdict?.status ?? item.status;
    itemStatuses.push(nextStatus);
    await db
      .from('payment_origination_items')
      .update({
        status: nextStatus,
        return_code: verdict?.returnCode ?? (nextStatus === 'RETURNED' ? item.returnCode : null),
        updated_at: now,
      })
      .eq('org_id', orgId)
      .eq('id', item.id);
  }

  const batchStatus = foldBatchStatus(itemStatuses);
  const { error: bErr } = await db
    .from('payment_origination_batches')
    .update({
      status: batchStatus,
      settled_at: batchStatus === 'SETTLED' ? now : batch.settledAt,
      trace: status.trace,
      updated_at: now,
    })
    .eq('org_id', orgId)
    .eq('id', batchId);
  if (bErr) throw new Error(bErr.message);

  const refreshed = await loadBatch(db, orgId, batchId);
  return refreshed ?? batch;
}

/** List all origination batches (+ items) for the org, newest first. */
export async function listOriginationBatches(db: SupabaseClient, orgId: string): Promise<OriginationBatch[]> {
  const { data: batches, error: bErr } = await db
    .from('payment_origination_batches')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (bErr) throw new Error(bErr.message);
  const batchRows = (batches ?? []) as BatchRow[];
  if (batchRows.length === 0) return [];

  const { data: items, error: iErr } = await db
    .from('payment_origination_items')
    .select('*')
    .eq('org_id', orgId)
    .in(
      'batch_id',
      batchRows.map((b) => b.id),
    );
  if (iErr) throw new Error(iErr.message);
  const itemsByBatch = new Map<string, OriginationItem[]>();
  for (const r of (items ?? []) as ItemRow[]) {
    const arr = itemsByBatch.get(r.batch_id) ?? [];
    arr.push(toItem(r));
    itemsByBatch.set(r.batch_id, arr);
  }
  return batchRows.map((b) => toBatch(b, itemsByBatch.get(b.id) ?? []));
}
