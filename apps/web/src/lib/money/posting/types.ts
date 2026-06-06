/**
 * GATE 12 — money-movement posting primitives.
 *
 * Pure entry builders (below, in ar-posting.ts / ap-posting.ts) construct the
 * balanced journal lines for each money-movement event from resolved account ids
 * + amounts. They are deliberately DB-free so the accounting can be verified for
 * balance in isolation (see verify-money-posting.mjs). Thin post wrappers resolve
 * roles and hand the lines to the existing postJournalEntry engine.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';

export interface MoneyMovementEntry {
  entryType: string;
  memo: string;
  lines: JournalEntryLineInput[];
}

/** Build one journal line (debit XOR credit). */
export function line(
  accountId: string,
  side: 'debit' | 'credit',
  cents: number,
  locationId: string,
  extra?: Partial<JournalEntryLineInput>,
): JournalEntryLineInput {
  if (cents < 0) throw new Error('line amount must be non-negative');
  return {
    account_id: accountId,
    debit_cents: side === 'debit' ? cents : 0,
    credit_cents: side === 'credit' ? cents : 0,
    location_id: locationId,
    ...extra,
  };
}

/** Throws unless debits == credits and the entry has >= 2 non-zero lines. */
export function assertBalanced(entry: MoneyMovementEntry): MoneyMovementEntry {
  const debits = entry.lines.reduce((s, l) => s + l.debit_cents, 0);
  const credits = entry.lines.reduce((s, l) => s + l.credit_cents, 0);
  if (debits !== credits) {
    throw new Error(`Unbalanced ${entry.entryType}: debits=${debits} credits=${credits}`);
  }
  if (debits === 0) throw new Error(`${entry.entryType} has no amounts`);
  if (entry.lines.filter((l) => l.debit_cents > 0 || l.credit_cents > 0).length < 2) {
    throw new Error(`${entry.entryType} needs at least 2 lines`);
  }
  return entry;
}
