/**
 * Bad-debt write-off posting for a customer AR invoice
 * (FPB-invoices Wave B, D5 / AC5.5).
 *
 * A write-off recognizes that an aged, unpaid receivable will not be collected.
 * The revenue was legitimately earned when the invoice was issued, so we do NOT
 * void the issuance entry (that would erase the sale). Instead we post a fresh,
 * balanced entry that relieves the receivable against a bad-debt expense:
 *
 *   DR Bad Debt Expense   (the open balance)
 *   CR Accounts Receivable control (the open balance)
 *
 * The pure builder (`buildWriteOffJournalLines`) and the balance math
 * (`computeWriteOff`) are I/O-free so the money-sensitive shape can be asserted
 * in isolation; the route resolves the AR control + bad-debt accounts and hands
 * the lines to `postJournalEntry` (which re-checks debits = credits at the DB
 * trigger — this never posts a guess).
 *
 * Account resolution: AR control resolves by the AR_CONTROL role. Bad Debt
 * Expense is now a first-class account role ('BAD_DEBT_EXPENSE') in
 * `posting/account-roles.ts`, so this module resolves it via `resolveRole`,
 * which walks (1) an explicit `account_roles` mapping, then (2) the role's
 * standard COA number fallback (6670). If the role can't resolve, we degrade to
 * (3) an active OPEX/COGS account whose name reads "bad debt" before finally
 * throwing WriteOffAccountUnresolvedError — never hard-coding a number at the
 * call site (canon §2/§3: reference accounts by role, never by a fixed number).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';

/** Thrown when the tenant's COA has no resolvable Bad Debt Expense account. */
export class WriteOffAccountUnresolvedError extends Error {
  code = 'BAD_DEBT_ACCOUNT_UNRESOLVED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WriteOffAccountUnresolvedError';
  }
}

export interface BuildWriteOffLinesArgs {
  /** Account to DEBIT — Bad Debt Expense (resolved by role/name). */
  badDebtAccountId: string;
  /** Account to CREDIT — AR control (role AR_CONTROL). */
  arAccountId: string;
  locationId: string;
  /** Job dimension carried onto both lines when the invoice is tied to a job. */
  jobId?: string | null;
  /** The open balance being written off, bigint cents (> 0). */
  amountCents: number;
}

/**
 * Build the balanced journal lines for a bad-debt write-off.
 *
 *   DR Bad Debt Expense (amount)
 *   CR Accounts Receivable control (amount)
 *
 * Debits === credits by construction. Throws if the amount is not a positive
 * integer cent value, or if the two accounts are the same (a no-op that would
 * silently balance to nothing meaningful).
 */
export function buildWriteOffJournalLines(args: BuildWriteOffLinesArgs): JournalEntryLineInput[] {
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error(`Write-off amount must be a positive integer cent value (got ${args.amountCents})`);
  }
  if (args.badDebtAccountId === args.arAccountId) {
    throw new Error('Bad Debt Expense and AR control cannot be the same account');
  }
  const jobDim = args.jobId ?? undefined;
  return [
    {
      account_id: args.badDebtAccountId,
      debit_cents: args.amountCents,
      credit_cents: 0,
      location_id: args.locationId,
      job_id: jobDim,
      memo: 'Bad debt write-off',
    },
    {
      account_id: args.arAccountId,
      debit_cents: 0,
      credit_cents: args.amountCents,
      location_id: args.locationId,
      job_id: jobDim,
      memo: 'Accounts receivable write-off',
    },
  ];
}

/**
 * The write-off amount and the invoice's next paid-amount.
 *
 * The open balance (total − already-paid) is what gets written off. To drop the
 * invoice from AR aging (which sums `balance_cents = total − amount_paid`), the
 * paid-amount is advanced to the full total so the generated balance is zero —
 * the same lever the credit-application path uses to relieve a balance without a
 * cash payment. `writeOffCents` is always ≥ 0.
 */
export function computeWriteOff(args: {
  totalCents: number;
  amountPaidCents: number;
}): { writeOffCents: number; newPaidCents: number } {
  const writeOffCents = Math.max(0, args.totalCents - args.amountPaidCents);
  return { writeOffCents, newPaidCents: args.totalCents };
}

interface AccountRow {
  id: string;
  account_type: string;
  name: string;
  account_number: string;
}

/**
 * Resolve the tenant's Bad Debt Expense account (see module header for the
 * strategy). Returns the account id; throws WriteOffAccountUnresolvedError when
 * the COA offers no defensible target.
 */
export async function resolveBadDebtAccount(
  db: SupabaseClient,
  orgId: string,
): Promise<{ id: string }> {
  // 1. Resolve by the BAD_DEBT_EXPENSE role — this walks the explicit
  //    account_roles mapping first, then the role's standard COA number
  //    fallback (6670). PostingError just means the role is unmapped and the
  //    fallback number isn't in this tenant's COA; we degrade below rather than
  //    fail hard, so a tenant with a differently-numbered "Bad Debt" account
  //    still works.
  try {
    const byRole = await resolveRole(db, orgId, 'BAD_DEBT_EXPENSE');
    if (byRole?.id) return { id: byRole.id };
  } catch (err) {
    if (!(err instanceof PostingError)) throw err;
  }

  // 2. Name match on an active expense account ("Bad Debt Expense").
  const { data: byName } = await db
    .from('accounts')
    .select('id, account_type, name, account_number')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .in('account_type', ['OPEX', 'COGS'])
    .ilike('name', '%bad debt%')
    .order('account_number', { ascending: true })
    .limit(1)
    .maybeSingle<AccountRow>();
  if (byName?.id) return { id: byName.id };

  // 3. Refuse to guess a number.
  throw new WriteOffAccountUnresolvedError(
    'No Bad Debt Expense account is configured for this tenant. Map the ' +
      'BAD_DEBT_EXPENSE role on the Account Roles screen, or add an active OPEX ' +
      'account named "Bad Debt Expense" to the chart of accounts.',
  );
}
