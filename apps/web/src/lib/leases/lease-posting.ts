/**
 * Lease persistence + posting (ASC 842).
 *
 *   persistLeaseWithSchedule — on human CONFIRM, compute the schedule deterministically
 *   (`buildLeaseSchedule`), insert the lease with its initial ROU asset + liability,
 *   insert every amortization line, AND post the ASC 842 commencement entry
 *   (DR ROU asset / CR Lease liability) so the GL control accounts tie to the register
 *   from day one. The commencement post is idempotent (stable source_ref per lease) and
 *   fails CLOSED — if it can't post, the whole lease is rolled back.
 *
 *   recordLeasePeriod — the monthly "record this period" action. Posts the next unposted
 *   schedule line as a balanced journal entry through `postJournalEntry`, resolving every
 *   account by ROLE. Idempotent: a line already carrying a gl_entry_id is skipped, and the
 *   posted entry stamps `source_id = line.id` so a retry can't double-post.
 *
 * Accounts are resolved by ROLE (never a hard-coded number). If a required lease role is
 * missing, the resolver throws PostingError and this DEGRADES to a reported failure —
 * it never guesses an account.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { resolveLeaseRole } from './lease-accounts';
import { buildLeaseSchedule, type LeaseSchedule, type LeaseTerms } from './schedule';

type DB = SupabaseClient;

export interface PersistLeaseInput {
  lessor: string;
  description?: string | null;
  locationId: string;
  classification: LeaseTerms['classification'];
  commencementDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  paymentCents: number;
  frequency: LeaseTerms['frequency'];
  paymentTiming: LeaseTerms['paymentTiming'];
  termMonths: number;
  discountRate: number;
  aiDecisionId?: string | null;
  notes?: string | null;
}

export interface PersistLeaseResult {
  leaseId: string;
  schedule: LeaseSchedule;
}

/** Last day of (commencement month + monthOffset), as YYYY-MM-DD (UTC). */
function periodEndDate(commencement: string, monthOffset: number): string {
  const d = new Date(`${commencement}T00:00:00Z`);
  // day 0 of (month + offset + 1) === last day of (month + offset).
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset + 1, 0))
    .toISOString()
    .slice(0, 10);
}

/**
 * Create the lease + full schedule (RLS-scoped). The schedule is computed here — the
 * source of truth — so persisted balances always tie to the engine.
 */
export async function persistLeaseWithSchedule(
  db: DB,
  orgId: string,
  userId: string | null,
  input: PersistLeaseInput,
): Promise<PersistLeaseResult> {
  const schedule = buildLeaseSchedule({
    classification: input.classification,
    paymentCents: input.paymentCents,
    frequency: input.frequency,
    termMonths: input.termMonths,
    annualDiscountRate: input.discountRate,
    paymentTiming: input.paymentTiming,
  });

  const { data: lease, error: leaseErr } = await db
    .from('leases')
    .insert({
      org_id: orgId,
      location_id: input.locationId,
      lessor: input.lessor,
      description: input.description ?? null,
      classification: input.classification,
      commencement_date: input.commencementDate,
      end_date: input.endDate,
      payment_cents: input.paymentCents,
      payment_frequency: input.frequency,
      payment_timing: input.paymentTiming ?? 'ARREARS',
      term_months: input.termMonths,
      discount_rate: input.discountRate,
      rou_asset_cents: schedule.rouAssetCents,
      liability_cents: schedule.liabilityCents,
      status: 'ACTIVE',
      periods_posted: 0,
      ai_decision_id: input.aiDecisionId ?? null,
      notes: input.notes ?? null,
      created_by_user: userId,
    })
    .select('id')
    .single();

  if (leaseErr || !lease) {
    throw new PostingError(`Failed to create lease: ${leaseErr?.message ?? 'unknown'}`);
  }
  const leaseId = (lease as { id: string }).id;

  const lineRows = schedule.lines.map((l) => ({
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

  const { error: linesErr } = await db.from('lease_schedule_lines').insert(lineRows);
  if (linesErr) {
    // Roll back the lease so a failed schedule never leaves a half-created lease.
    await db.from('leases').delete().eq('id', leaseId);
    throw new PostingError(`Failed to create lease schedule: ${linesErr.message}`);
  }

  // Post the ASC 842 commencement entry so the GL ties to the register immediately.
  // Fail CLOSED: if the opening JE can't post (unmapped role / no open period), roll
  // the lease + schedule back rather than leave a subledger that can never tie out.
  try {
    await recordLeaseCommencement(db, orgId, userId, {
      leaseId,
      locationId: input.locationId,
      rouAssetCents: schedule.rouAssetCents,
      liabilityCents: schedule.liabilityCents,
      entryDate: input.commencementDate,
    });
  } catch (e) {
    await db.from('lease_schedule_lines').delete().eq('lease_id', leaseId);
    await db.from('leases').delete().eq('id', leaseId);
    throw e;
  }

  return { leaseId, schedule };
}

/** Stable ref for the one-time commencement entry (idempotency guard per lease). */
export function leaseCommencementRef(leaseId: string): string {
  return `lease:commencement:${leaseId}`;
}

export interface RecordLeaseCommencementInput {
  leaseId: string;
  locationId: string;
  /** Initial ROU asset (cents) — equals the initial liability in this model. */
  rouAssetCents: number;
  /** Initial lease liability (cents) = PV of the remaining payments. */
  liabilityCents: number;
  /** Commencement date (YYYY-MM-DD). */
  entryDate: string;
}

export interface CommencementResult {
  posted: boolean;
  entryId?: string;
  entryNumber?: string | null;
  alreadyPosted: boolean;
  message: string;
}

/**
 * Post the ASC 842 initial-recognition entry for a lease: DR Right-of-Use Asset /
 * CR Lease Liability for the initial measurement. Both legs resolve BY ROLE (ROU_ASSET,
 * LEASE_LIABILITY) and the amounts are equal by construction, so the entry balances.
 * Idempotent: guarded on a stable source_ref, so a re-run posts nothing and reports the
 * existing entry. Degrades (PostingError) rather than guess an account.
 */
export async function recordLeaseCommencement(
  db: DB,
  orgId: string,
  userId: string | null,
  input: RecordLeaseCommencementInput,
): Promise<CommencementResult> {
  if (input.rouAssetCents <= 0 || input.liabilityCents <= 0) {
    // Nothing to recognize (e.g. a fully-prepaid / zero-PV lease) — not an error.
    return { posted: false, alreadyPosted: false, message: 'No initial ROU/liability to recognize.' };
  }

  const sourceRef = leaseCommencementRef(input.leaseId);
  const { data: existing } = await db
    .from('gl_entries')
    .select('id, entry_number, status')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .neq('status', 'VOIDED')
    .limit(1)
    .maybeSingle<{ id: string; entry_number: string | null; status: string }>();
  if (existing) {
    return {
      posted: false,
      alreadyPosted: true,
      entryId: existing.id,
      entryNumber: existing.entry_number,
      message: 'Lease commencement already posted.',
    };
  }

  const locationId = input.locationId;
  const rouAsset = await resolveLeaseRole(db, orgId, 'ROU_ASSET', locationId);
  const leaseLiability = await resolveLeaseRole(db, orgId, 'LEASE_LIABILITY', locationId);

  const lines = [
    { account_id: rouAsset.id, debit_cents: input.rouAssetCents, credit_cents: 0, location_id: locationId, memo: 'ROU asset — lease commencement' },
    { account_id: leaseLiability.id, debit_cents: 0, credit_cents: input.liabilityCents, location_id: locationId, memo: 'Lease liability — commencement' },
  ];

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: locationId,
    entry_date: input.entryDate,
    entry_type: 'STANDARD',
    memo: 'Lease commencement (ASC 842) — initial recognition',
    source_module: 'LEASE',
    source_ref: sourceRef,
    created_by: userId,
    lines,
  });
  if (!je.success || !je.entry_id) {
    throw new PostingError(je.error ?? 'Failed to post lease commencement');
  }

  return {
    posted: true,
    alreadyPosted: false,
    entryId: je.entry_id,
    entryNumber: je.entry_number ?? null,
    message: `Posted lease commencement (${je.entry_number ?? je.entry_id}).`,
  };
}

export interface RecordPeriodResult {
  posted: boolean;
  period?: number;
  entryId?: string;
  entryNumber?: string;
  message: string;
}

interface LeaseRow {
  id: string;
  location_id: string;
  classification: 'OPERATING' | 'FINANCE';
  status: string;
  term_months: number;
  periods_posted: number;
}

interface ScheduleLineRow {
  id: string;
  period: number;
  period_date: string;
  payment_cents: number;
  interest_cents: number;
  principal_reduction_cents: number;
  rou_amortization_cents: number;
  lease_expense_cents: number;
  gl_entry_id: string | null;
}

/**
 * Post the next unposted schedule line for a lease as a balanced journal entry.
 * Resolves accounts by ROLE and degrades (throws PostingError) rather than guess.
 */
export async function recordLeasePeriod(
  db: DB,
  orgId: string,
  userId: string | null,
  leaseId: string,
): Promise<RecordPeriodResult> {
  const { data: leaseData, error: leaseErr } = await db
    .from('leases')
    .select('id, location_id, classification, status, term_months, periods_posted')
    .eq('org_id', orgId)
    .eq('id', leaseId)
    .maybeSingle<LeaseRow>();
  if (leaseErr) throw new PostingError(`Lease lookup failed: ${leaseErr.message}`);
  if (!leaseData) throw new PostingError('Lease not found');
  if (leaseData.status !== 'ACTIVE') {
    return { posted: false, message: `Lease is ${leaseData.status}; nothing to post.` };
  }

  // Next unposted line (lowest period first). gl_entry_id null is the double-post guard.
  const { data: lineData, error: lineErr } = await db
    .from('lease_schedule_lines')
    .select(
      'id, period, period_date, payment_cents, interest_cents, principal_reduction_cents, rou_amortization_cents, lease_expense_cents, gl_entry_id',
    )
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .is('gl_entry_id', null)
    .order('period', { ascending: true })
    .limit(1)
    .maybeSingle<ScheduleLineRow>();
  if (lineErr) throw new PostingError(`Schedule lookup failed: ${lineErr.message}`);
  if (!lineData) {
    return { posted: false, message: 'All lease periods have already been recorded.' };
  }

  const locationId = leaseData.location_id;
  const line = lineData;

  // Resolve accounts by ROLE (degrade-safe: PostingError if a role is unmapped/unseeded).
  const rouAsset = await resolveLeaseRole(db, orgId, 'ROU_ASSET', locationId);
  const leaseLiability = await resolveLeaseRole(db, orgId, 'LEASE_LIABILITY', locationId);
  const bank = await resolveRole(db, orgId, 'OPERATING_BANK', locationId);

  const lines: {
    account_id: string;
    debit_cents: number;
    credit_cents: number;
    location_id: string;
    memo?: string;
  }[] = [];

  if (leaseData.classification === 'OPERATING') {
    const leaseExpense = await resolveLeaseRole(db, orgId, 'LEASE_EXPENSE', locationId);
    // DR Lease Expense; DR Lease Liability(principal); CR ROU(amort); CR Cash(payment).
    lines.push({ account_id: leaseExpense.id, debit_cents: line.lease_expense_cents, credit_cents: 0, location_id: locationId, memo: 'Operating lease expense' });
    lines.push({ account_id: leaseLiability.id, debit_cents: line.principal_reduction_cents, credit_cents: 0, location_id: locationId, memo: 'Lease liability reduction' });
    lines.push({ account_id: rouAsset.id, debit_cents: 0, credit_cents: line.rou_amortization_cents, location_id: locationId, memo: 'ROU amortization' });
    lines.push({ account_id: bank.id, debit_cents: 0, credit_cents: line.payment_cents, location_id: locationId, memo: 'Lease payment' });
  } else {
    const interestExpense = await resolveLeaseRole(db, orgId, 'LEASE_INTEREST_EXPENSE', locationId);
    const amortExpense = await resolveLeaseRole(db, orgId, 'ROU_AMORTIZATION_EXPENSE', locationId);
    // DR Interest; DR Liability(principal); DR Amortization; CR Cash(payment); CR ROU(amort).
    lines.push({ account_id: interestExpense.id, debit_cents: line.interest_cents, credit_cents: 0, location_id: locationId, memo: 'Finance lease interest' });
    lines.push({ account_id: leaseLiability.id, debit_cents: line.principal_reduction_cents, credit_cents: 0, location_id: locationId, memo: 'Lease liability reduction' });
    lines.push({ account_id: amortExpense.id, debit_cents: line.rou_amortization_cents, credit_cents: 0, location_id: locationId, memo: 'ROU amortization' });
    lines.push({ account_id: bank.id, debit_cents: 0, credit_cents: line.payment_cents, location_id: locationId, memo: 'Lease payment' });
    lines.push({ account_id: rouAsset.id, debit_cents: 0, credit_cents: line.rou_amortization_cents, location_id: locationId, memo: 'ROU amortization' });
  }

  // Drop any zero-value legs (e.g. an interest-free period) — keeps the entry clean.
  const nonZero = lines.filter((l) => l.debit_cents !== 0 || l.credit_cents !== 0);

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: locationId,
    entry_date: line.period_date,
    entry_type: 'ADJUSTING',
    memo: `Lease period ${line.period} — ${leaseData.classification === 'OPERATING' ? 'operating' : 'finance'} lease`,
    source_module: 'LEASE',
    source_id: line.id, // uuid → lands in gl_entries.source_id; guards double-post
    created_by: userId,
    lines: nonZero,
  });

  if (!je.success) {
    return { posted: false, period: line.period, message: je.error ?? 'Posting failed' };
  }

  // Stamp the line + advance the lease. Guard against a concurrent post by only
  // updating the row while it is still unposted.
  await db
    .from('lease_schedule_lines')
    .update({ gl_entry_id: je.entry_id, posted_at: new Date().toISOString() })
    .eq('id', line.id)
    .is('gl_entry_id', null);

  const newPosted = leaseData.periods_posted + 1;
  // The lease is fully recognized when no unposted schedule line remains — this is
  // frequency-agnostic (monthly/quarterly/annual all resolve correctly).
  const { count: remaining } = await db
    .from('lease_schedule_lines')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('lease_id', leaseId)
    .is('gl_entry_id', null);
  await db
    .from('leases')
    .update({
      periods_posted: newPosted,
      status: (remaining ?? 0) <= 0 ? 'ENDED' : 'ACTIVE',
      updated_at: new Date().toISOString(),
    })
    .eq('id', leaseId);

  return {
    posted: true,
    period: line.period,
    entryId: je.entry_id,
    entryNumber: je.entry_number,
    message: `Posted lease period ${line.period} (${je.entry_number ?? je.entry_id}).`,
  };
}
