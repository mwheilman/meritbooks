/**
 * Debt lifecycle services — variable-rate RESET, REFINANCE, and PAYOFF against the
 * owned ledger. Each has a pure PREVIEW (compute-only, nothing written) and a CONFIRM
 * (persist + post). All run on the RLS-scoped client so org isolation is the DB's job.
 *
 *  - RESET rebuilds only the REMAINING schedule at a new rate; already-posted periods
 *    are never rewritten. A reset is not itself a ledger event (future accruals carry
 *    the new interest), so it posts NO journal entry — it records the change on the
 *    instrument (rate, payment, term, a notes marker).
 *  - REFINANCE closes the old instrument, opens a new linked one for the refinanced
 *    balance + terms, and posts the balanced debt-rollover entry (DR old debt / CR new
 *    debt, the difference settled in cash) by ROLE through postJournalEntry.
 *  - PAYOFF settles the instrument: DR remaining principal (liability) + DR accrued
 *    interest / CR cash, marks it PAID_OFF, and zeroes the schedule forward.
 *
 * Money is bigint cents. Every posting resolves accounts by ROLE and carries a stable
 * source_ref guarded against a double post (canon §3: the ledger is the guarantor).
 *
 * SCHEMA NOTE (reported to the lead — NOT applied): there is no migration column for
 * refinance lineage or a lifecycle audit trail, so old<->new links and reset history
 * are recorded as machine-readable markers appended to `notes` ([MB:refi_to=…],
 * [MB:refi_from=…], [MB:reset …], [MB:payoff …]). A follow-up migration should add
 * `debt_instruments.refinanced_from_id/refinanced_to_id uuid` + `closed_date date` and
 * a `debt_events` audit table (event_type, effective_date, gl_entry_id, meta jsonb).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { PostingError, getAccountRef, resolveRole, type AccountRef } from '@/lib/posting/account-roles';
import { resolveDebtAccounts } from './accounts';
import { createDebtInstrument, type CreateDebtResult } from './create';
import type { CreateDebtInput } from './schema';
import {
  rebuildScheduleFromReset,
  computeRefinanceRollover,
  computePayoffSettlement,
  type ResetMode,
  type ResetResult,
} from './reset';
import { buildAmortizationSchedule, type ScheduleLine, type PaymentFrequency, type AmortizationMethod } from './amortization';

type DB = SupabaseClient;
const SOURCE_MODULE = 'DEBT';

// ── Loaders ─────────────────────────────────────────────────────────────────────

interface InstrumentRow {
  id: string;
  org_id: string;
  location_id: string | null;
  loan_name: string;
  original_amount_cents: number;
  interest_rate: number | string;
  rate_type: string;
  amortization_method: AmortizationMethod;
  payment_frequency: PaymentFrequency;
  status: string;
  notes: string | null;
  liability_account_id: string | null;
  interest_expense_account_id: string | null;
  interest_payable_account_id: string | null;
  cash_account_id: string | null;
}

// PostgREST aliases map the EXISTING migration-008 columns onto the feature field
// names (name -> loan_name, original_amount_cents/monthly_payment_cents stay,
// gl_liability_account_id -> liability_account_id, gl_interest_account_id ->
// interest_expense_account_id). Do NOT rename the columns — this alias is the contract.
const INSTRUMENT_COLS =
  'id, org_id, location_id, loan_name:name, original_amount_cents, interest_rate, rate_type, ' +
  'amortization_method, payment_frequency, status, notes, ' +
  'liability_account_id:gl_liability_account_id, interest_expense_account_id:gl_interest_account_id, ' +
  'interest_payable_account_id, cash_account_id';

interface DbScheduleRow {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  principal_balance_cents: number;
}

async function loadInstrument(db: DB, orgId: string, id: string): Promise<InstrumentRow> {
  const { data, error } = await db
    .from('debt_instruments')
    .select(INSTRUMENT_COLS)
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle<InstrumentRow>();
  if (error) throw new PostingError(`Debt instrument lookup failed: ${error.message}`);
  if (!data) throw new PostingError('Debt instrument not found');
  return data;
}

async function loadSchedule(db: DB, orgId: string, id: string): Promise<DbScheduleRow[]> {
  const { data, error } = await db
    .from('debt_schedule_lines')
    .select('period, period_date, payment_cents, interest_cents, principal_cents, principal_balance_cents')
    .eq('org_id', orgId)
    .eq('instrument_id', id)
    .order('period', { ascending: true });
  if (error) throw new PostingError(`Schedule lookup failed: ${error.message}`);
  return (data ?? []) as DbScheduleRow[];
}

/** The set of DEBT source_refs already posted (non-voided) for this instrument. */
async function loadPostedRefs(db: DB, orgId: string, id: string): Promise<Set<string>> {
  const { data } = await db
    .from('gl_entries')
    .select('source_ref, status')
    .eq('org_id', orgId)
    .eq('source_module', SOURCE_MODULE)
    .neq('status', 'VOIDED')
    .like('source_ref', `debt:%:${id}:%`);
  const refs = new Set<string>();
  for (const e of (data ?? []) as { source_ref: string | null }[]) if (e.source_ref) refs.add(e.source_ref);
  return refs;
}

async function findEntryByRef(db: DB, orgId: string, sourceRef: string): Promise<{ id: string; entry_number: string | null } | null> {
  const { data } = await db
    .from('gl_entries')
    .select('id, entry_number, status')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .neq('status', 'VOIDED')
    .limit(1)
    .maybeSingle<{ id: string; entry_number: string | null; status: string }>();
  return data ? { id: data.id, entry_number: data.entry_number } : null;
}

function toScheduleLines(rows: DbScheduleRow[]): ScheduleLine[] {
  return rows.map((r) => ({
    period: r.period,
    periodDate: r.period_date,
    paymentCents: r.payment_cents,
    interestCents: r.interest_cents,
    principalCents: r.principal_cents,
    principalBalanceCents: r.principal_balance_cents,
  }));
}

/** Highest period with a posted accrual OR payment (0 when none posted). */
function maxPostedPeriod(refs: Set<string>, id: string): number {
  let max = 0;
  for (const ref of refs) {
    const m = new RegExp(`^debt:(?:accrual|payment):${id}:(\\d+)$`).exec(ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Highest period with a posted PAYMENT (0 when none paid). */
function lastPaidPeriod(refs: Set<string>, id: string): number {
  let max = 0;
  for (const ref of refs) {
    const m = new RegExp(`^debt:payment:${id}:(\\d+)$`).exec(ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Current outstanding principal = balance after the last paid period, else original. */
function currentOutstanding(schedule: DbScheduleRow[], refs: Set<string>, id: string, originalCents: number): number {
  const paid = lastPaidPeriod(refs, id);
  if (paid <= 0) return originalCents;
  const line = schedule.find((l) => l.period === paid);
  return line ? line.principal_balance_cents : originalCents;
}

function appendNote(existing: string | null, marker: string): string {
  return existing && existing.trim().length > 0 ? `${existing}\n${marker}` : marker;
}

// ── RESET ─────────────────────────────────────────────────────────────────────

export interface ResetArgs {
  orgId: string;
  instrumentId: string;
  newRatePercent: number;
  resetAtPeriod?: number | null;
  mode?: ResetMode;
  resetDate?: string | null;
}

export interface ResetPreview {
  currentRatePercent: number;
  newRatePercent: number;
  resetAtPeriod: number;
  mode: ResetMode;
  outstandingBalanceCents: number;
  previousPaymentCents: number;
  newPaymentCents: number;
  remainingPeriods: number;
  preservedCount: number;
  newLines: ScheduleLine[];
}

async function computeReset(db: DB, args: ResetArgs): Promise<{ inst: InstrumentRow; result: ResetResult; resetAt: number }> {
  const inst = await loadInstrument(db, args.orgId, args.instrumentId);
  if (inst.status !== 'ACTIVE') throw new PostingError(`Cannot reset a ${inst.status.toLowerCase()} loan`);
  const rows = await loadSchedule(db, args.orgId, args.instrumentId);
  if (rows.length === 0) throw new PostingError('This loan has no amortization schedule to reset');
  const refs = await loadPostedRefs(db, args.orgId, args.instrumentId);
  const posted = maxPostedPeriod(refs, args.instrumentId);

  const resetAt = args.resetAtPeriod ?? posted + 1;
  if (resetAt <= posted) {
    throw new PostingError(`Period ${resetAt} is already posted — a reset can only rebuild future periods (from ${posted + 1}).`);
  }

  const result = rebuildScheduleFromReset({
    existingLines: toScheduleLines(rows),
    resetAtPeriod: resetAt,
    newAnnualRatePercent: args.newRatePercent,
    frequency: inst.payment_frequency,
    method: inst.amortization_method,
    mode: args.mode,
    resetDate: args.resetDate ?? null,
  });
  return { inst, result, resetAt };
}

export async function previewReset(db: DB, args: ResetArgs): Promise<ResetPreview> {
  const { inst, result, resetAt } = await computeReset(db, args);
  return {
    currentRatePercent: Number(inst.interest_rate),
    newRatePercent: args.newRatePercent,
    resetAtPeriod: resetAt,
    mode: result.mode,
    outstandingBalanceCents: result.outstandingBalanceCents,
    previousPaymentCents: result.previousPaymentCents,
    newPaymentCents: result.newPaymentCents,
    remainingPeriods: result.remainingPeriods,
    preservedCount: result.preservedLines.length,
    newLines: result.newLines,
  };
}

export async function confirmReset(db: DB, args: ResetArgs): Promise<ResetPreview> {
  const { inst, result, resetAt } = await computeReset(db, args);

  // Replace the future tail: upsert the recomputed lines, then delete any leftover
  // lines beyond the new (possibly shorter) schedule. Upsert-first avoids ever leaving
  // the instrument scheduleless.
  const maxNewPeriod = result.newLines.reduce((m, l) => Math.max(m, l.period), resetAt - 1);
  const rows = result.newLines.map((l) => ({
    org_id: args.orgId,
    instrument_id: args.instrumentId,
    period: l.period,
    period_date: l.periodDate,
    payment_cents: l.paymentCents,
    interest_cents: l.interestCents,
    principal_cents: l.principalCents,
    principal_balance_cents: l.principalBalanceCents,
  }));
  const { error: upErr } = await db.from('debt_schedule_lines').upsert(rows, { onConflict: 'instrument_id,period' });
  if (upErr) throw new PostingError(`Failed to write the reset schedule: ${upErr.message}`);

  const { error: delErr } = await db
    .from('debt_schedule_lines')
    .delete()
    .eq('org_id', args.orgId)
    .eq('instrument_id', args.instrumentId)
    .gte('period', resetAt)
    .gt('period', maxNewPeriod);
  if (delErr) throw new PostingError(`Failed to trim the reset schedule: ${delErr.message}`);

  const marker = `[MB:reset p${resetAt} ${Number(inst.interest_rate)}%→${args.newRatePercent}% ${result.mode}${
    args.resetDate ? ` eff ${args.resetDate}` : ''
  }]`;
  const { error: updErr } = await db
    .from('debt_instruments')
    .update({
      interest_rate: args.newRatePercent,
      monthly_payment_cents: result.newPaymentCents,
      term_periods: result.fullSchedule.length,
      notes: appendNote(inst.notes, marker),
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', args.orgId)
    .eq('id', args.instrumentId);
  if (updErr) throw new PostingError(`Failed to update the loan after reset: ${updErr.message}`);

  return {
    currentRatePercent: Number(inst.interest_rate),
    newRatePercent: args.newRatePercent,
    resetAtPeriod: resetAt,
    mode: result.mode,
    outstandingBalanceCents: result.outstandingBalanceCents,
    previousPaymentCents: result.previousPaymentCents,
    newPaymentCents: result.newPaymentCents,
    remainingPeriods: result.remainingPeriods,
    preservedCount: result.preservedLines.length,
    newLines: result.newLines,
  };
}

// ── REFINANCE ────────────────────────────────────────────────────────────────

export interface EntryLinePreview {
  label: string;
  account_number: string | null;
  debit_cents: number;
  credit_cents: number;
}

export interface RefinancePreview {
  oldBalanceCents: number;
  newPrincipalCents: number;
  cashDebitCents: number;
  cashCreditCents: number;
  entryLines: EntryLinePreview[];
  newSchedule: { periods: number; regularPaymentCents: number; totalInterestCents: number };
}

/** Resolve the three accounts a refinance rollover needs (old debt, new debt, cash). */
async function resolveRefinanceAccounts(
  db: DB,
  orgId: string,
  oldLiabilityId: string | null,
  newLiabilityId: string | null,
  cashOverrideId: string | null,
  locationId: string,
): Promise<{ oldLiability: AccountRef; newLiability: AccountRef; cash: AccountRef }> {
  if (!oldLiabilityId) {
    throw new PostingError('The loan being refinanced has no notes-payable account set — set it before refinancing.');
  }
  if (!newLiabilityId) {
    throw new PostingError('The new loan needs a notes-payable account so the refinanced debt can be booked.');
  }
  const oldLiability = await getAccountRef(db, orgId, oldLiabilityId);
  const newLiability = await getAccountRef(db, orgId, newLiabilityId);
  const cash = cashOverrideId ? await getAccountRef(db, orgId, cashOverrideId) : await resolveRole(db, orgId, 'OPERATING_BANK', locationId);
  return { oldLiability, newLiability, cash };
}

export async function previewRefinance(
  db: DB,
  orgId: string,
  oldId: string,
  newTerms: CreateDebtInput,
): Promise<RefinancePreview> {
  const old = await loadInstrument(db, orgId, oldId);
  if (old.status !== 'ACTIVE') throw new PostingError(`Cannot refinance a ${old.status.toLowerCase()} loan`);
  const schedule = await loadSchedule(db, orgId, oldId);
  const refs = await loadPostedRefs(db, orgId, oldId);
  const oldBalance = currentOutstanding(schedule, refs, oldId, old.original_amount_cents);

  const rollover = computeRefinanceRollover(oldBalance, newTerms.principal_cents);
  const location = newTerms.location_id ?? old.location_id;
  if (!location) throw new PostingError('A company/location is required to post the refinance to the ledger.');

  const accts = await resolveRefinanceAccounts(
    db,
    orgId,
    old.liability_account_id,
    newTerms.liability_account_id ?? null,
    newTerms.cash_account_id ?? old.cash_account_id,
    location,
  );

  const sched = buildAmortizationSchedule({
    principalCents: newTerms.principal_cents,
    annualRatePercent: newTerms.interest_rate,
    frequency: newTerms.payment_frequency,
    method: newTerms.amortization_method,
    termPeriods: newTerms.term_periods ?? null,
    paymentCents: newTerms.payment_cents ?? null,
    originationDate: newTerms.origination_date ?? null,
  });

  const entryLines: EntryLinePreview[] = [
    { label: `Extinguish ${old.loan_name}`, account_number: accts.oldLiability.account_number, debit_cents: rollover.drOldLiabilityCents, credit_cents: 0 },
    { label: `Book ${newTerms.loan_name}`, account_number: accts.newLiability.account_number, debit_cents: 0, credit_cents: rollover.crNewLiabilityCents },
  ];
  if (rollover.cashDebitCents > 0)
    entryLines.push({ label: 'Cash-out proceeds', account_number: accts.cash.account_number, debit_cents: rollover.cashDebitCents, credit_cents: 0 });
  if (rollover.cashCreditCents > 0)
    entryLines.push({ label: 'Cash paid at close', account_number: accts.cash.account_number, debit_cents: 0, credit_cents: rollover.cashCreditCents });

  return {
    oldBalanceCents: oldBalance,
    newPrincipalCents: newTerms.principal_cents,
    cashDebitCents: rollover.cashDebitCents,
    cashCreditCents: rollover.cashCreditCents,
    entryLines,
    newSchedule: { periods: sched.periods, regularPaymentCents: sched.regularPaymentCents, totalInterestCents: sched.totalInterestCents },
  };
}

export interface RefinanceResult {
  newInstrumentId: string;
  glEntryId: string;
  entryNumber: string | null;
  oldBalanceCents: number;
  newPrincipalCents: number;
}

export async function confirmRefinance(
  db: DB,
  orgId: string,
  userId: string | null,
  oldId: string,
  newTerms: CreateDebtInput,
): Promise<RefinanceResult> {
  const old = await loadInstrument(db, orgId, oldId);
  if (old.status !== 'ACTIVE') throw new PostingError(`Cannot refinance a ${old.status.toLowerCase()} loan`);
  const schedule = await loadSchedule(db, orgId, oldId);
  const refs = await loadPostedRefs(db, orgId, oldId);
  const oldBalance = currentOutstanding(schedule, refs, oldId, old.original_amount_cents);
  const rollover = computeRefinanceRollover(oldBalance, newTerms.principal_cents);

  const location = newTerms.location_id ?? old.location_id;
  if (!location) throw new PostingError('A company/location is required to post the refinance to the ledger.');

  // Resolve accounts up front so a misconfigured refi fails before anything is written.
  const accts = await resolveRefinanceAccounts(
    db,
    orgId,
    old.liability_account_id,
    newTerms.liability_account_id ?? null,
    newTerms.cash_account_id ?? old.cash_account_id,
    location,
  );

  // Create the NEW instrument + schedule (linked back to the old one via a note marker).
  const linkedTerms: CreateDebtInput = {
    ...newTerms,
    location_id: location,
    notes: appendNote(newTerms.notes ?? null, `[MB:refi_from=${oldId}]`),
  };
  let created: CreateDebtResult;
  try {
    // Refinance books the new liability itself via the rollover entry below, so DON'T
    // post an origination JE here (it would double-credit the new liability).
    created = await createDebtInstrument(db, orgId, userId, linkedTerms, { postOrigination: false });
  } catch (e) {
    throw new PostingError(`Failed to create the refinanced loan: ${e instanceof Error ? e.message : String(e)}`);
  }
  const newId = created.id;

  const sourceRef = `debt:refi:${oldId}:${newId}`;
  const existing = await findEntryByRef(db, orgId, sourceRef);
  if (existing) {
    return { newInstrumentId: newId, glEntryId: existing.id, entryNumber: existing.entry_number, oldBalanceCents: oldBalance, newPrincipalCents: newTerms.principal_cents };
  }

  const memo = `Refinance — ${old.loan_name} → ${newTerms.loan_name}`;
  const lines: JournalEntryLineInput[] = [
    { account_id: accts.oldLiability.id, debit_cents: rollover.drOldLiabilityCents, credit_cents: 0, location_id: location, memo },
    { account_id: accts.newLiability.id, debit_cents: 0, credit_cents: rollover.crNewLiabilityCents, location_id: location, memo },
  ];
  if (rollover.cashDebitCents > 0) lines.push({ account_id: accts.cash.id, debit_cents: rollover.cashDebitCents, credit_cents: 0, location_id: location, memo });
  if (rollover.cashCreditCents > 0) lines.push({ account_id: accts.cash.id, debit_cents: 0, credit_cents: rollover.cashCreditCents, location_id: location, memo });

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: location,
    entry_date: newTerms.origination_date ?? new Date().toISOString().slice(0, 10),
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) {
    // Roll the new instrument back so a failed post never leaves an orphan loan.
    await db.from('debt_instruments').delete().eq('org_id', orgId).eq('id', newId);
    throw new PostingError(je.error ?? 'Failed to post the refinance entry');
  }

  // Close the old instrument and cross-link it to the new one.
  const { error: closeErr } = await db
    .from('debt_instruments')
    .update({
      status: 'CLOSED',
      current_balance_cents: 0,
      notes: appendNote(old.notes, `[MB:refi_to=${newId}]`),
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', oldId);
  if (closeErr) throw new PostingError(`Refinance posted but failed to close the old loan: ${closeErr.message}`);

  return { newInstrumentId: newId, glEntryId: je.entry_id, entryNumber: je.entry_number ?? null, oldBalanceCents: oldBalance, newPrincipalCents: newTerms.principal_cents };
}

// ── PAYOFF ─────────────────────────────────────────────────────────────────────

export interface PayoffArgs {
  orgId: string;
  instrumentId: string;
  payoffDate?: string | null;
  additionalInterestCents?: number | null;
  userId?: string | null;
}

export interface PayoffPreview {
  remainingPrincipalCents: number;
  accruedPayableCents: number;
  additionalInterestCents: number;
  totalCashCents: number;
  entryLines: EntryLinePreview[];
}

async function computePayoff(db: DB, args: PayoffArgs): Promise<{
  inst: InstrumentRow;
  location: string;
  outstanding: number;
  accruedPayable: number;
  additional: number;
  lastPaid: number;
  accts: Awaited<ReturnType<typeof resolveDebtAccounts>>;
}> {
  const inst = await loadInstrument(db, args.orgId, args.instrumentId);
  if (inst.status !== 'ACTIVE') throw new PostingError(`This loan is already ${inst.status.toLowerCase()}`);
  if (!inst.location_id) throw new PostingError('A company/location is required to post the payoff to the ledger.');
  if (!inst.liability_account_id) throw new PostingError('Set the notes-payable account on the loan before paying it off.');

  const schedule = await loadSchedule(db, args.orgId, args.instrumentId);
  const refs = await loadPostedRefs(db, args.orgId, args.instrumentId);
  const lastPaid = lastPaidPeriod(refs, args.instrumentId);
  const outstanding = currentOutstanding(schedule, refs, args.instrumentId, inst.original_amount_cents);

  // Interest accrued (posted) but not yet cleared by a payment sits in Interest Payable.
  let accruedPayable = 0;
  for (const l of schedule) {
    const accrued = refs.has(`debt:accrual:${args.instrumentId}:${l.period}`);
    const paid = refs.has(`debt:payment:${args.instrumentId}:${l.period}`);
    if (accrued && !paid) accruedPayable += l.interest_cents;
  }
  const additional = Math.max(0, Math.round(args.additionalInterestCents ?? 0));

  const accts = await resolveDebtAccounts(db, args.orgId, {
    liabilityAccountId: inst.liability_account_id,
    interestExpenseAccountId: inst.interest_expense_account_id,
    interestPayableAccountId: inst.interest_payable_account_id,
    cashAccountId: inst.cash_account_id,
    locationId: inst.location_id,
  });
  if (!accts.liability) throw new PostingError('Could not resolve the notes-payable account for this loan.');

  return { inst, location: inst.location_id, outstanding, accruedPayable, additional, lastPaid, accts };
}

export async function previewPayoff(db: DB, args: PayoffArgs): Promise<PayoffPreview> {
  const { outstanding, accruedPayable, additional, accts } = await computePayoff(db, args);
  const settlement = computePayoffSettlement(outstanding, accruedPayable, additional);

  const entryLines: EntryLinePreview[] = [
    { label: 'Remaining principal', account_number: accts.liability?.account_number ?? null, debit_cents: settlement.remainingPrincipalCents, credit_cents: 0 },
  ];
  if (accruedPayable > 0)
    entryLines.push({ label: 'Clear accrued interest', account_number: accts.interestPayable.account_number, debit_cents: accruedPayable, credit_cents: 0 });
  if (additional > 0)
    entryLines.push({ label: 'Per-diem interest', account_number: accts.interestExpense.account_number, debit_cents: additional, credit_cents: 0 });
  entryLines.push({ label: 'Cash', account_number: accts.cash.account_number, debit_cents: 0, credit_cents: settlement.totalCashCents });

  return {
    remainingPrincipalCents: settlement.remainingPrincipalCents,
    accruedPayableCents: settlement.accruedPayableCents,
    additionalInterestCents: settlement.additionalInterestCents,
    totalCashCents: settlement.totalCashCents,
    entryLines,
  };
}

export interface PayoffResult {
  glEntryId: string;
  entryNumber: string | null;
  totalCashCents: number;
  alreadyPosted: boolean;
}

export async function confirmPayoff(db: DB, args: PayoffArgs): Promise<PayoffResult> {
  const { inst, location, outstanding, accruedPayable, additional, lastPaid, accts } = await computePayoff(db, args);
  const settlement = computePayoffSettlement(outstanding, accruedPayable, additional);

  const sourceRef = `debt:payoff:${args.instrumentId}`;
  const existing = await findEntryByRef(db, args.orgId, sourceRef);
  if (existing) {
    return { glEntryId: existing.id, entryNumber: existing.entry_number, totalCashCents: settlement.totalCashCents, alreadyPosted: true };
  }

  const memo = `Loan payoff — ${inst.loan_name}`;
  const liabilityId = accts.liability?.id;
  if (!liabilityId) throw new PostingError('Could not resolve the notes-payable account for this loan.');
  const lines: JournalEntryLineInput[] = [
    { account_id: liabilityId, debit_cents: settlement.remainingPrincipalCents, credit_cents: 0, location_id: location, memo },
  ];
  if (accruedPayable > 0) lines.push({ account_id: accts.interestPayable.id, debit_cents: accruedPayable, credit_cents: 0, location_id: location, memo });
  if (additional > 0) lines.push({ account_id: accts.interestExpense.id, debit_cents: additional, credit_cents: 0, location_id: location, memo });
  lines.push({ account_id: accts.cash.id, debit_cents: 0, credit_cents: settlement.totalCashCents, location_id: location, memo });

  const je = await postJournalEntry(db, {
    org_id: args.orgId,
    location_id: location,
    entry_date: args.payoffDate ?? new Date().toISOString().slice(0, 10),
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post the payoff entry');

  // Mark PAID_OFF and zero the schedule forward (no further accruals/payments expected).
  const marker = `[MB:payoff ${args.payoffDate ?? new Date().toISOString().slice(0, 10)} bal ${outstanding}]`;
  await db
    .from('debt_instruments')
    .update({ status: 'PAID_OFF', current_balance_cents: 0, notes: appendNote(inst.notes, marker), updated_at: new Date().toISOString() })
    .eq('org_id', args.orgId)
    .eq('id', args.instrumentId);

  await db
    .from('debt_schedule_lines')
    .update({ payment_cents: 0, interest_cents: 0, principal_cents: 0, principal_balance_cents: 0 })
    .eq('org_id', args.orgId)
    .eq('instrument_id', args.instrumentId)
    .gt('period', lastPaid);

  return { glEntryId: je.entry_id, entryNumber: je.entry_number ?? null, totalCashCents: settlement.totalCashCents, alreadyPosted: false };
}
