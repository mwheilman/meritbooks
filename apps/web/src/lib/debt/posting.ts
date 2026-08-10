/**
 * Debt posting — interest accrual and scheduled payment through the owned ledger.
 *
 * Both entries post via the deterministic `postJournalEntry` (debits must equal
 * credits or nothing posts) and resolve accounts BY ROLE (see accounts.ts). Every
 * entry carries a stable `source_ref` and is guarded against a double post — the
 * same instrument+period cannot accrue or pay twice (canon §3: never re-expense a
 * settlement; the ledger is the guarantor).
 *
 *   Interest accrual (for a period):   DR Interest Expense / CR Interest Payable
 *   Scheduled payment (for a period):
 *     - if the period was previously accrued:  DR Interest Payable + DR Debt / CR Cash
 *     - otherwise (pay interest directly):     DR Interest Expense + DR Debt / CR Cash
 *
 * All money is bigint cents. Debit/credit sides are set explicitly from the stored
 * schedule line, so no figure is ever recomputed at post time.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { PostingError, type AccountRef } from '@/lib/posting/account-roles';
import { resolveDebtAccounts, resolveDebtLiability } from './accounts';

type DB = SupabaseClient;

const SOURCE_MODULE = 'DEBT';

export interface DebtInstrumentRow {
  id: string;
  org_id: string;
  location_id: string | null;
  loan_name: string;
  original_amount_cents: number;
  origination_date: string | null;
  liability_account_id: string | null;
  interest_expense_account_id: string | null;
  interest_payable_account_id: string | null;
  cash_account_id: string | null;
}

export interface DebtScheduleLineRow {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
}

export interface DebtPostResult {
  gl_entry_id: string;
  entry_number: string | null;
  interest_cents: number;
  principal_cents: number;
  /** True when a matching entry already existed (idempotent no-op). */
  alreadyPosted: boolean;
}

// PostgREST aliases map the EXISTING migration-008 columns to the DebtInstrumentRow
// field names (name -> loan_name, gl_liability_account_id -> liability_account_id,
// gl_interest_account_id -> interest_expense_account_id).
const INSTRUMENT_COLS =
  'id, org_id, location_id, loan_name:name, original_amount_cents, origination_date, ' +
  'liability_account_id:gl_liability_account_id, ' +
  'interest_expense_account_id:gl_interest_account_id, interest_payable_account_id, cash_account_id';

async function loadInstrument(db: DB, orgId: string, instrumentId: string): Promise<DebtInstrumentRow> {
  const { data, error } = await db
    .from('debt_instruments')
    .select(INSTRUMENT_COLS)
    .eq('org_id', orgId)
    .eq('id', instrumentId)
    .maybeSingle<DebtInstrumentRow>();
  if (error) throw new PostingError(`Debt instrument lookup failed: ${error.message}`);
  if (!data) throw new PostingError('Debt instrument not found');
  return data;
}

async function loadScheduleLine(
  db: DB,
  orgId: string,
  instrumentId: string,
  period: number,
): Promise<DebtScheduleLineRow> {
  const { data, error } = await db
    .from('debt_schedule_lines')
    .select('period, period_date, payment_cents, interest_cents, principal_cents')
    .eq('org_id', orgId)
    .eq('instrument_id', instrumentId)
    .eq('period', period)
    .maybeSingle<DebtScheduleLineRow>();
  if (error) throw new PostingError(`Schedule line lookup failed: ${error.message}`);
  if (!data) throw new PostingError(`No schedule line for period ${period}`);
  return data;
}

/** Existing non-voided GL entry with this source_ref, if any (idempotency guard). */
async function findExistingEntry(
  db: DB,
  orgId: string,
  sourceRef: string,
): Promise<{ id: string; entry_number: string | null } | null> {
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

function accrualRef(instrumentId: string, period: number): string {
  return `debt:accrual:${instrumentId}:${period}`;
}
function paymentRef(instrumentId: string, period: number): string {
  return `debt:payment:${instrumentId}:${period}`;
}
/** Stable ref for the one-time origination entry (idempotency guard per instrument). */
export function originationRef(instrumentId: string): string {
  return `debt:origination:${instrumentId}`;
}

/**
 * PURE: the two balanced legs recognizing loan proceeds at origination —
 * DR Cash (proceeds) / CR Notes Payable (principal). Money is bigint cents.
 */
export function buildDebtOriginationLines(
  accts: { cash: AccountRef; liability: AccountRef },
  principalCents: number,
  locationId: string,
  memo: string,
): JournalEntryLineInput[] {
  return [
    { account_id: accts.cash.id, debit_cents: principalCents, credit_cents: 0, location_id: locationId, memo },
    { account_id: accts.liability.id, debit_cents: 0, credit_cents: principalCents, location_id: locationId, memo },
  ];
}

/**
 * PURE: the balanced legs for a scheduled loan payment. Principal reduces the
 * notes-payable liability (DR); interest is cleared from Interest Payable when the
 * period was already accrued, else expensed now (DR); Cash is credited for the full
 * payment. Zero-value legs are omitted. Money is bigint cents.
 */
export function buildDebtPaymentLines(
  accts: { interestDebit: AccountRef; liability: AccountRef | null; cash: AccountRef },
  amounts: { interestCents: number; principalCents: number },
  locationId: string,
  memo: string,
): JournalEntryLineInput[] {
  const lines: JournalEntryLineInput[] = [];
  if (amounts.interestCents > 0) {
    lines.push({ account_id: accts.interestDebit.id, debit_cents: amounts.interestCents, credit_cents: 0, location_id: locationId, memo });
  }
  if (amounts.principalCents > 0 && accts.liability) {
    lines.push({ account_id: accts.liability.id, debit_cents: amounts.principalCents, credit_cents: 0, location_id: locationId, memo });
  }
  lines.push({ account_id: accts.cash.id, debit_cents: 0, credit_cents: amounts.interestCents + amounts.principalCents, location_id: locationId, memo });
  return lines;
}

export interface RecordDebtOriginationArgs {
  orgId: string;
  instrumentId: string;
  /** Posting date (YYYY-MM-DD). Defaults to the instrument's origination date, else today. */
  entryDate?: string | null;
  userId?: string | null;
}

/**
 * Recognize loan proceeds at origination: DR Cash (or the instrument's proceeds
 * account) / CR Notes Payable (the instrument's liability account, else NOTES_PAYABLE
 * role). Idempotent per instrument via a stable source_ref — a re-run posts nothing and
 * returns the existing entry. Resolves accounts BY ROLE and degrades (PostingError)
 * rather than guess.
 */
export async function recordDebtOrigination(db: DB, args: RecordDebtOriginationArgs): Promise<DebtPostResult> {
  const instrument = await loadInstrument(db, args.orgId, args.instrumentId);
  if (!instrument.location_id) {
    throw new PostingError('This loan has no location — set a company/location before posting to the ledger.');
  }
  const principal = instrument.original_amount_cents;
  if (!principal || principal <= 0) {
    throw new PostingError('Loan has no principal to recognize.');
  }

  const sourceRef = originationRef(args.instrumentId);
  const existing = await findExistingEntry(db, args.orgId, sourceRef);
  if (existing) {
    return {
      gl_entry_id: existing.id,
      entry_number: existing.entry_number,
      interest_cents: 0,
      principal_cents: principal,
      alreadyPosted: true,
    };
  }

  const location = instrument.location_id;
  // Proceeds land in the instrument's cash account override, else the OPERATING_BANK
  // role (resolveDebtAccounts handles that fallback); liability by override → role.
  const accts = await resolveDebtAccounts(db, args.orgId, {
    cashAccountId: instrument.cash_account_id,
    interestExpenseAccountId: instrument.interest_expense_account_id,
    interestPayableAccountId: instrument.interest_payable_account_id,
    locationId: location,
  });
  const liability = await resolveDebtLiability(db, args.orgId, instrument.liability_account_id, location);

  const memo = `Loan origination — ${instrument.loan_name}`;
  const lines = buildDebtOriginationLines({ cash: accts.cash, liability }, principal, location, memo);

  const entryDate = args.entryDate ?? instrument.origination_date ?? new Date().toISOString().slice(0, 10);
  const je = await postJournalEntry(db, {
    org_id: args.orgId,
    location_id: location,
    entry_date: entryDate,
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: args.userId ?? null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post loan origination');

  return {
    gl_entry_id: je.entry_id,
    entry_number: je.entry_number ?? null,
    interest_cents: 0,
    principal_cents: principal,
    alreadyPosted: false,
  };
}

export interface RecordDebtEntryArgs {
  orgId: string;
  instrumentId: string;
  period: number;
  /** Posting date (YYYY-MM-DD). Defaults to the schedule line's date, else today. */
  entryDate?: string | null;
  userId?: string | null;
}

/** Record the interest accrual for a period: DR Interest Expense / CR Interest Payable. */
export async function recordInterestAccrual(db: DB, args: RecordDebtEntryArgs): Promise<DebtPostResult> {
  const instrument = await loadInstrument(db, args.orgId, args.instrumentId);
  if (!instrument.location_id) {
    throw new PostingError('This loan has no location — set a company/location before posting to the ledger.');
  }
  const line = await loadScheduleLine(db, args.orgId, args.instrumentId, args.period);
  if (line.interest_cents <= 0) {
    throw new PostingError(`Period ${args.period} has no interest to accrue`);
  }

  const sourceRef = accrualRef(args.instrumentId, args.period);
  const existing = await findExistingEntry(db, args.orgId, sourceRef);
  if (existing) {
    return {
      gl_entry_id: existing.id,
      entry_number: existing.entry_number,
      interest_cents: line.interest_cents,
      principal_cents: 0,
      alreadyPosted: true,
    };
  }

  const accts = await resolveDebtAccounts(db, args.orgId, {
    interestExpenseAccountId: instrument.interest_expense_account_id,
    interestPayableAccountId: instrument.interest_payable_account_id,
    cashAccountId: instrument.cash_account_id,
    locationId: instrument.location_id,
  });

  const location = instrument.location_id;
  const memo = `Interest accrual — ${instrument.loan_name} · period ${args.period}`;
  const lines: JournalEntryLineInput[] = [
    { account_id: accts.interestExpense.id, debit_cents: line.interest_cents, credit_cents: 0, location_id: location, memo },
    { account_id: accts.interestPayable.id, debit_cents: 0, credit_cents: line.interest_cents, location_id: location, memo },
  ];

  const entryDate = args.entryDate ?? line.period_date ?? new Date().toISOString().slice(0, 10);
  const je = await postJournalEntry(db, {
    org_id: args.orgId,
    location_id: location,
    entry_date: entryDate,
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post interest accrual');

  return {
    gl_entry_id: je.entry_id,
    entry_number: je.entry_number ?? null,
    interest_cents: line.interest_cents,
    principal_cents: 0,
    alreadyPosted: false,
  };
}

/**
 * Record the scheduled payment for a period. Interest is cleared from Interest
 * Payable when the period was already accrued (never re-expensed); otherwise it is
 * expensed directly. Principal reduces the notes-payable liability. Cash is credited
 * for the full payment.
 */
export async function recordDebtPayment(db: DB, args: RecordDebtEntryArgs): Promise<DebtPostResult> {
  const instrument = await loadInstrument(db, args.orgId, args.instrumentId);
  if (!instrument.location_id) {
    throw new PostingError('This loan has no location — set a company/location before posting to the ledger.');
  }
  const line = await loadScheduleLine(db, args.orgId, args.instrumentId, args.period);

  const sourceRef = paymentRef(args.instrumentId, args.period);
  const existing = await findExistingEntry(db, args.orgId, sourceRef);
  if (existing) {
    return {
      gl_entry_id: existing.id,
      entry_number: existing.entry_number,
      interest_cents: line.interest_cents,
      principal_cents: line.principal_cents,
      alreadyPosted: true,
    };
  }

  const accts = await resolveDebtAccounts(db, args.orgId, {
    liabilityAccountId: instrument.liability_account_id,
    interestExpenseAccountId: instrument.interest_expense_account_id,
    interestPayableAccountId: instrument.interest_payable_account_id,
    cashAccountId: instrument.cash_account_id,
    locationId: instrument.location_id,
  });
  // Principal (DR Notes Payable): the instrument override if set, else the NOTES_PAYABLE
  // role (degrades to a PostingError if neither is configured/seeded — never a guess).
  let liability = accts.liability;
  if (line.principal_cents > 0 && !liability) {
    liability = await resolveDebtLiability(db, args.orgId, null, instrument.location_id);
  }

  // If this period was already accrued, clear the payable; otherwise expense it now.
  const accrued = await findExistingEntry(db, args.orgId, accrualRef(args.instrumentId, args.period));
  const interestDebit = accrued ? accts.interestPayable : accts.interestExpense;

  const location = instrument.location_id;
  const payment = line.interest_cents + line.principal_cents;
  if (payment <= 0) throw new PostingError(`Period ${args.period} has no payment amount`);
  const memo = `Loan payment — ${instrument.loan_name} · period ${args.period}`;

  const lines = buildDebtPaymentLines(
    { interestDebit, liability, cash: accts.cash },
    { interestCents: line.interest_cents, principalCents: line.principal_cents },
    location,
    memo,
  );

  const entryDate = args.entryDate ?? line.period_date ?? new Date().toISOString().slice(0, 10);
  const je = await postJournalEntry(db, {
    org_id: args.orgId,
    location_id: location,
    entry_date: entryDate,
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post loan payment');

  return {
    gl_entry_id: je.entry_id,
    entry_number: je.entry_number ?? null,
    interest_cents: line.interest_cents,
    principal_cents: line.principal_cents,
    alreadyPosted: false,
  };
}
