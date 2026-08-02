/**
 * Lease remeasurement persistence + posting (ASC 842).
 *
 * The deterministic engine computes the numbers (`modify.ts`); this layer:
 *   - resolves the lease's CARRYING state at the effective date (from the last posted
 *     schedule line, or the inception balances when nothing has posted yet),
 *   - PREVIEWS a modification / CPI reset / termination — proposing the remeasured
 *     ROU + liability + the resulting balanced entry, WITHOUT touching the ledger, and
 *   - on human CONFIRM, posts the adjusting entry through `postJournalEntry` (accounts
 *     by ROLE), rebuilds the remaining schedule from the effective period forward
 *     (already-posted periods untouched), and updates the lease.
 *
 * Already-posted periods are preserved: we NEVER read or modify a schedule line that
 * carries a gl_entry_id. The rebuild deletes only UNPOSTED forward lines and re-inserts
 * the revised ones, so the period numbers continue past the last posted period.
 *
 * Idempotency: each adjusting entry posts with a deterministic `source_ref`
 * (`LEASE_MOD:…` / `LEASE_TERM:…`). Migration 064's UNIQUE (org_id, source_ref,
 * entry_type) index is the DB double-post guarantor; we also pre-check for an existing
 * entry so a re-clicked confirm returns "already applied" cleanly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { resolveRole, PostingError, type AccountRef } from '@/lib/posting/account-roles';
import { resolveLeaseRole } from './lease-accounts';
import {
  remeasureLease,
  computeTermination,
  legsBalance,
  type RemeasurementResult,
  type TerminationResult,
  type RemeasureLeg,
  type LeaseCarryingState,
  type RevisedTerms,
} from './modify';
import { buildRemainingSchedule, type LeaseFrequency, type PaymentTiming, type LeaseClassification } from './schedule';

type DB = SupabaseClient;

const MONTHS_PER_PERIOD: Record<LeaseFrequency, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

interface LeaseRow {
  id: string;
  location_id: string;
  classification: LeaseClassification;
  commencement_date: string;
  payment_frequency: LeaseFrequency;
  payment_timing: PaymentTiming;
  discount_rate: number | string;
  rou_asset_cents: number;
  liability_cents: number;
  status: string;
}

interface PostedLineRow {
  period: number;
  liability_balance_cents: number;
  rou_balance_cents: number;
}

interface UnpostedLineRow {
  id: string;
  period: number;
  period_date: string;
}

/** Resolved carrying position at the effective (remeasurement) date. */
export interface CarryingContext {
  lease: LeaseRow;
  state: LeaseCarryingState;
  /** Period number of the first UNPOSTED (remaining) line — the effective period. */
  effectivePeriod: number;
  /** Date the adjusting entry posts on (the effective period's period-end date). */
  effectiveDate: string;
  /** Count of remaining unposted periods before the remeasurement. */
  currentRemainingPeriods: number;
}

/** Last day of (commencement month + monthOffset), YYYY-MM-DD (UTC). Mirrors lease-posting. */
function periodEndDate(commencement: string, monthOffset: number): string {
  const d = new Date(`${commencement}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset + 1, 0)).toISOString().slice(0, 10);
}

/** Small deterministic hash → base36, so identical proposals dedupe but distinct ones don't collide. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Load the lease + its carrying balances at the effective date. Throws PostingError if
 * the lease is missing or not ACTIVE, or if there is nothing left to remeasure.
 */
export async function loadCarryingContext(db: DB, orgId: string, leaseId: string): Promise<CarryingContext> {
  const { data: lease, error } = await db
    .from('leases')
    .select(
      'id, location_id, classification, commencement_date, payment_frequency, payment_timing, discount_rate, rou_asset_cents, liability_cents, status',
    )
    .eq('org_id', orgId)
    .eq('id', leaseId)
    .maybeSingle<LeaseRow>();
  if (error) throw new PostingError(`Lease lookup failed: ${error.message}`);
  if (!lease) throw new PostingError('Lease not found');
  if (lease.status !== 'ACTIVE') throw new PostingError(`Lease is ${lease.status}; it can no longer be remeasured.`);

  // Last POSTED line gives the carrying balances at the effective date.
  const { data: posted } = await db
    .from('lease_schedule_lines')
    .select('period, liability_balance_cents, rou_balance_cents')
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .not('gl_entry_id', 'is', null)
    .order('period', { ascending: false })
    .limit(1)
    .maybeSingle<PostedLineRow>();

  // First UNPOSTED line is the effective period (the remeasurement applies from here).
  const { data: nextUnposted } = await db
    .from('lease_schedule_lines')
    .select('id, period, period_date')
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .is('gl_entry_id', null)
    .order('period', { ascending: true })
    .limit(1)
    .maybeSingle<UnpostedLineRow>();

  const { count: remaining } = await db
    .from('lease_schedule_lines')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .is('gl_entry_id', null);

  const currentRemainingPeriods = remaining ?? 0;
  if (currentRemainingPeriods <= 0 || !nextUnposted) {
    throw new PostingError('No remaining (unposted) periods — nothing to remeasure or terminate.');
  }

  const carryingLiabilityCents = Number(posted?.liability_balance_cents ?? lease.liability_cents);
  const carryingRouCents = Number(posted?.rou_balance_cents ?? lease.rou_asset_cents);

  return {
    lease,
    state: {
      classification: lease.classification,
      frequency: lease.payment_frequency,
      paymentTiming: lease.payment_timing,
      carryingLiabilityCents,
      carryingRouCents,
    },
    effectivePeriod: nextUnposted.period,
    effectiveDate: nextUnposted.period_date,
    currentRemainingPeriods,
  };
}

/** Resolve a remeasurement leg role to a real tenant account (lease roles + gain/loss + bank). */
async function resolveLeg(db: DB, orgId: string, leg: RemeasureLeg, locationId: string): Promise<AccountRef> {
  switch (leg.role) {
    case 'GAIN_ON_DISPOSAL':
    case 'LOSS_ON_DISPOSAL':
    case 'OPERATING_BANK':
      return resolveRole(db, orgId, leg.role, locationId);
    default:
      return resolveLeaseRole(db, orgId, leg.role, locationId);
  }
}

export interface RemeasurePreview {
  effectivePeriod: number;
  effectiveDate: string;
  before: { liabilityCents: number; rouCents: number; remainingPeriods: number };
  after: { liabilityCents: number; rouCents: number; remainingPeriods: number };
  result: RemeasurementResult;
}

export interface ModificationInput {
  paymentCents: number;
  remainingPeriods: number;
  annualDiscountRate: number;
  scopeReduction?: boolean;
}

/** Compute (no I/O to the GL) a modification preview. */
export async function previewModification(
  db: DB,
  orgId: string,
  leaseId: string,
  input: ModificationInput,
): Promise<RemeasurePreview> {
  const ctx = await loadCarryingContext(db, orgId, leaseId);
  const revised: RevisedTerms = {
    paymentCents: input.paymentCents,
    remainingPeriods: input.remainingPeriods,
    annualDiscountRate: input.annualDiscountRate,
  };
  const result = remeasureLease(ctx.state, revised, ctx.currentRemainingPeriods, input.scopeReduction);
  return {
    effectivePeriod: ctx.effectivePeriod,
    effectiveDate: ctx.effectiveDate,
    before: {
      liabilityCents: ctx.state.carryingLiabilityCents,
      rouCents: ctx.state.carryingRouCents,
      remainingPeriods: ctx.currentRemainingPeriods,
    },
    after: {
      liabilityCents: result.revisedLiabilityCents,
      rouCents: result.newRouCents,
      remainingPeriods: input.remainingPeriods,
    },
    result,
  };
}

/** CPI/index reset = remeasurement with the ORIGINAL rate + SAME remaining term. */
export async function previewCpiReset(
  db: DB,
  orgId: string,
  leaseId: string,
  newPaymentCents: number,
): Promise<RemeasurePreview> {
  const ctx = await loadCarryingContext(db, orgId, leaseId);
  const originalRate = Number(ctx.lease.discount_rate);
  return previewModification(db, orgId, leaseId, {
    paymentCents: newPaymentCents,
    remainingPeriods: ctx.currentRemainingPeriods,
    annualDiscountRate: originalRate,
    scopeReduction: false,
  });
}

export interface ConfirmResult {
  applied: boolean;
  alreadyApplied?: boolean;
  entryId?: string;
  entryNumber?: string;
  message: string;
  preview: RemeasurePreview;
}

/** Guard: has an entry with this source_ref already posted (idempotency)? */
async function findExistingEntry(db: DB, orgId: string, sourceRef: string): Promise<{ id: string; entry_number: string } | null> {
  const { data } = await db
    .from('gl_entries')
    .select('id, entry_number, status')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .neq('status', 'VOIDED')
    .limit(1)
    .maybeSingle<{ id: string; entry_number: string; status: string }>();
  return data ? { id: data.id, entry_number: data.entry_number } : null;
}

/**
 * CONFIRM a modification / CPI reset: post the adjusting entry, rebuild the forward
 * schedule, update the lease. Idempotent on source_ref.
 */
export async function confirmRemeasurement(
  db: DB,
  orgId: string,
  userId: string | null,
  leaseId: string,
  input: ModificationInput,
  kind: 'MOD' | 'CPI',
): Promise<ConfirmResult> {
  const preview = await previewModification(db, orgId, leaseId, input);
  const ctx = await loadCarryingContext(db, orgId, leaseId);
  const { lease } = ctx;
  const { result } = preview;

  const sourceRef =
    `LEASE_${kind}:${leaseId}:${ctx.effectivePeriod}:` +
    shortHash(`${result.treatment}|${input.paymentCents}|${input.remainingPeriods}|${input.annualDiscountRate}|${result.gainLossCents}`);

  const existing = await findExistingEntry(db, orgId, sourceRef);
  if (existing) {
    return { applied: false, alreadyApplied: true, entryId: existing.id, entryNumber: existing.entry_number, message: 'This remeasurement was already recorded.', preview };
  }

  // Post the adjusting entry (skip when the remeasurement is a pure no-op, e.g. CPI with
  // an unchanged index — nothing to book, but we still rebuild the forward schedule).
  let entryId: string | undefined;
  let entryNumber: string | undefined;
  if (result.legs.length > 0) {
    if (!legsBalance(result.legs)) throw new PostingError('Internal error: remeasurement legs do not balance.');
    const resolved = await Promise.all(result.legs.map((l) => resolveLeg(db, orgId, l, lease.location_id)));
    const je = await postJournalEntry(db, {
      org_id: orgId,
      location_id: lease.location_id,
      entry_date: ctx.effectiveDate,
      entry_type: 'ADJUSTING',
      memo: `Lease ${kind === 'CPI' ? 'CPI/index reset' : 'modification'} — ${result.treatment === 'SCOPE_REDUCTION' ? 'partial termination' : 'remeasurement'} (period ${ctx.effectivePeriod})`,
      source_module: 'LEASE',
      source_ref: sourceRef,
      created_by: userId,
      lines: result.legs.map((l, i) => ({
        account_id: resolved[i].id,
        debit_cents: l.debitCents,
        credit_cents: l.creditCents,
        location_id: lease.location_id,
        memo: l.memo,
      })),
    });
    if (!je.success) throw new PostingError(je.error ?? 'Failed to post remeasurement entry');
    entryId = je.entry_id;
    entryNumber = je.entry_number;
  }

  await rebuildForwardSchedule(db, orgId, leaseId, {
    classification: lease.classification,
    frequency: lease.payment_frequency,
    paymentTiming: lease.payment_timing,
    commencementDate: lease.commencement_date,
    startPeriod: ctx.effectivePeriod,
    openingLiabilityCents: result.revisedLiabilityCents,
    openingRouCents: result.newRouCents,
    paymentCents: input.paymentCents,
    remainingPeriods: input.remainingPeriods,
    annualDiscountRate: input.annualDiscountRate,
  });

  await db
    .from('leases')
    .update({
      liability_cents: result.revisedLiabilityCents,
      rou_asset_cents: result.newRouCents,
      payment_cents: input.paymentCents,
      discount_rate: input.annualDiscountRate,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', leaseId);

  return {
    applied: true,
    entryId,
    entryNumber,
    message: entryNumber
      ? `Lease remeasured and schedule rebuilt. Adjusting entry ${entryNumber}.`
      : 'Lease remeasured (no adjusting entry required) and schedule rebuilt.',
    preview,
  };
}

interface RebuildInput {
  classification: LeaseClassification;
  frequency: LeaseFrequency;
  paymentTiming: PaymentTiming;
  commencementDate: string;
  startPeriod: number;
  openingLiabilityCents: number;
  openingRouCents: number;
  paymentCents: number;
  remainingPeriods: number;
  annualDiscountRate: number;
}

/**
 * Replace the UNPOSTED forward schedule with the revised one. Posted lines (they carry a
 * gl_entry_id) are never touched. New lines continue the period numbering from the
 * effective period and use the ORIGINAL commencement + frequency for period dates.
 */
async function rebuildForwardSchedule(db: DB, orgId: string, leaseId: string, input: RebuildInput): Promise<void> {
  const monthsPerPeriod = MONTHS_PER_PERIOD[input.frequency];
  const startMonthOffset = (input.startPeriod - 1) * monthsPerPeriod;

  const lines = buildRemainingSchedule({
    classification: input.classification,
    openingLiabilityCents: input.openingLiabilityCents,
    openingRouCents: input.openingRouCents,
    paymentCents: input.paymentCents,
    frequency: input.frequency,
    periods: input.remainingPeriods,
    annualDiscountRate: input.annualDiscountRate,
    paymentTiming: input.paymentTiming,
    startPeriod: input.startPeriod,
    startMonthOffset,
  });

  // Delete only the UNPOSTED forward lines, then insert the revised ones.
  const { error: delErr } = await db
    .from('lease_schedule_lines')
    .delete()
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .is('gl_entry_id', null);
  if (delErr) throw new PostingError(`Failed to clear forward schedule: ${delErr.message}`);

  const rows = lines.map((l) => ({
    org_id: orgId,
    lease_id: leaseId,
    period: l.period,
    period_date: periodEndDate(input.commencementDate, l.monthOffset),
    payment_cents: l.paymentCents,
    interest_cents: l.interestCents,
    principal_reduction_cents: l.principalReductionCents,
    liability_balance_cents: l.liabilityBalanceCents,
    rou_amortization_cents: l.rouAmortizationCents,
    rou_balance_cents: l.rouBalanceCents,
    lease_expense_cents: l.leaseExpenseCents,
  }));
  const { error: insErr } = await db.from('lease_schedule_lines').insert(rows);
  if (insErr) throw new PostingError(`Failed to write revised schedule: ${insErr.message}`);
}

export interface TerminationPreview {
  effectivePeriod: number;
  effectiveDate: string;
  result: TerminationResult;
}

export async function previewTermination(
  db: DB,
  orgId: string,
  leaseId: string,
  penaltyCents: number,
): Promise<TerminationPreview> {
  const ctx = await loadCarryingContext(db, orgId, leaseId);
  const result = computeTermination(ctx.state, penaltyCents);
  return { effectivePeriod: ctx.effectivePeriod, effectiveDate: ctx.effectiveDate, result };
}

export interface ConfirmTerminationResult {
  applied: boolean;
  alreadyApplied?: boolean;
  entryId?: string;
  entryNumber?: string;
  message: string;
  preview: TerminationPreview;
}

/**
 * CONFIRM an early termination: post the write-off entry, drop the remaining unposted
 * schedule lines, mark the lease TERMINATED. Idempotent on source_ref.
 */
export async function confirmTermination(
  db: DB,
  orgId: string,
  userId: string | null,
  leaseId: string,
  penaltyCents: number,
): Promise<ConfirmTerminationResult> {
  const preview = await previewTermination(db, orgId, leaseId, penaltyCents);
  const ctx = await loadCarryingContext(db, orgId, leaseId);
  const { lease } = ctx;
  const { result } = preview;

  const sourceRef = `LEASE_TERM:${leaseId}:${ctx.effectivePeriod}:${penaltyCents}`;
  const existing = await findExistingEntry(db, orgId, sourceRef);
  if (existing) {
    return { applied: false, alreadyApplied: true, entryId: existing.id, entryNumber: existing.entry_number, message: 'This lease was already terminated.', preview };
  }

  if (result.legs.length > 0) {
    if (!legsBalance(result.legs)) throw new PostingError('Internal error: termination legs do not balance.');
    const resolved = await Promise.all(result.legs.map((l) => resolveLeg(db, orgId, l, lease.location_id)));
    const je = await postJournalEntry(db, {
      org_id: orgId,
      location_id: lease.location_id,
      entry_date: ctx.effectiveDate,
      entry_type: 'ADJUSTING',
      memo: `Lease termination (period ${ctx.effectivePeriod}) — write off ROU + liability`,
      source_module: 'LEASE',
      source_ref: sourceRef,
      created_by: userId,
      lines: result.legs.map((l, i) => ({
        account_id: resolved[i].id,
        debit_cents: l.debitCents,
        credit_cents: l.creditCents,
        location_id: lease.location_id,
        memo: l.memo,
      })),
    });
    if (!je.success) throw new PostingError(je.error ?? 'Failed to post termination entry');

    // Drop the remaining unposted schedule and mark the lease terminated.
    await db.from('lease_schedule_lines').delete().eq('org_id', orgId).eq('lease_id', leaseId).is('gl_entry_id', null);
    await db
      .from('leases')
      .update({ status: 'TERMINATED', rou_asset_cents: 0, liability_cents: 0, updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('id', leaseId);

    return { applied: true, entryId: je.entry_id, entryNumber: je.entry_number, message: `Lease terminated. Write-off entry ${je.entry_number}.`, preview };
  }

  // Nothing carrying to write off — just mark terminated.
  await db.from('lease_schedule_lines').delete().eq('org_id', orgId).eq('lease_id', leaseId).is('gl_entry_id', null);
  await db
    .from('leases')
    .update({ status: 'TERMINATED', rou_asset_cents: 0, liability_cents: 0, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', leaseId);
  return { applied: true, message: 'Lease terminated (no carrying balance to write off).', preview };
}
