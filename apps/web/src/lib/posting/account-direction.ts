/**
 * Account-type-aware debit/credit direction.
 *
 * This is the single rule the whole posting engine rests on (Transaction &
 * Posting Engine Spec, Part A.2): debits and credits are NEVER passed in by a
 * caller — they are DERIVED from the account's type and whether the entry is
 * increasing or decreasing that account. This is the first place the system is
 * structurally more accurate than a human bookkeeper: it cannot miscode an
 * expense as a credit.
 *
 *   Normal balance by type:
 *     ASSET, COGS, OPEX        -> DEBIT
 *     LIABILITY, EQUITY, REVENUE -> CREDIT
 *     OTHER -> resolved by sub-type (OTHER_INCOME = CREDIT, OTHER_EXPENSE = DEBIT)
 *
 *   Increasing a normal-DEBIT account  -> debit;  decreasing -> credit
 *   Increasing a normal-CREDIT account -> credit; decreasing -> debit
 */

export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COGS'
  | 'OPEX'
  | 'OTHER';

export type AccountSubType =
  | 'CURRENT_ASSET'
  | 'FIXED_ASSET'
  | 'OTHER_ASSET'
  | 'CURRENT_LIABILITY'
  | 'LONG_TERM_LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COST_OF_GOODS_SOLD'
  | 'OPERATING_EXPENSE'
  | 'OTHER_INCOME'
  | 'OTHER_EXPENSE';

export type NormalBalance = 'DEBIT' | 'CREDIT';

/** Whether a posting leg increases or decreases the account it touches. */
export type Effect = 'increase' | 'decrease';

/** Debit/credit split for a single GL line, in cents. */
export interface DebitCredit {
  debit_cents: number;
  credit_cents: number;
}

/**
 * Normal balance of an account. Sub-type only matters for OTHER (income vs
 * expense); for every other type the top-level type is sufficient.
 */
export function normalBalanceFor(
  accountType: AccountType,
  subType?: AccountSubType
): NormalBalance {
  switch (accountType) {
    case 'ASSET':
    case 'COGS':
    case 'OPEX':
      return 'DEBIT';
    case 'LIABILITY':
    case 'EQUITY':
    case 'REVENUE':
      return 'CREDIT';
    case 'OTHER':
      return subType === 'OTHER_INCOME' ? 'CREDIT' : 'DEBIT';
    default: {
      // Exhaustiveness guard — a new enum value forces a compile error here.
      const _never: never = accountType;
      return _never;
    }
  }
}

/**
 * Derive the debit/credit split for a leg from the account's type and the
 * intended effect. The amount must be a non-negative integer number of cents.
 */
export function debitCreditFor(
  accountType: AccountType,
  effect: Effect,
  amountCents: number,
  subType?: AccountSubType
): DebitCredit {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error(`Amount must be a non-negative integer cents value, got ${amountCents}`);
  }
  const isDebitNormal = normalBalanceFor(accountType, subType) === 'DEBIT';
  const postsAsDebit = isDebitNormal === (effect === 'increase');
  return postsAsDebit
    ? { debit_cents: amountCents, credit_cents: 0 }
    : { debit_cents: 0, credit_cents: amountCents };
}
