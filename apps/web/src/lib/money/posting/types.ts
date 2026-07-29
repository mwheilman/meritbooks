/**
 * GATE 12 — money-movement posting primitives.
 *
 * Pure entry builders (below, in ar-posting.ts / ap-posting.ts) construct the
 * balanced journal lines for each money-movement event from resolved account ids
 * + amounts. They are deliberately DB-free so the accounting can be verified for
 * balance in isolation (see verify-money-posting.mjs). Thin post wrappers resolve
 * roles and hand the lines to the existing postJournalEntry engine.
 */

import type { JournalEntryLineInput, PostResult } from '@/lib/services/gl-posting';
import { postJournalEntry } from '@/lib/services/gl-posting';
import type { SupabaseClient } from '@supabase/supabase-js';

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

/**
 * Post a money-movement entry through the GL engine. The single shared wrapper
 * for AR / AP / payroll / platform-fee posting — the processor id (Stripe pi_/po_,
 * Plaid txn) goes to source_ref (external string), never source_id (uuid). Was
 * duplicated verbatim in three modules; consolidated here so a change to how
 * money-movement entries post happens in one place.
 */
export function postMoneyMovementEntry(
  supabase: SupabaseClient,
  args: {
    orgId: string;
    locationId: string;
    entryDate: string;
    createdBy: string | null;
    entry: MoneyMovementEntry;
    sourceId?: string;
    sourceModule?: string;
  },
): Promise<PostResult> {
  return postJournalEntry(supabase, {
    org_id: args.orgId,
    location_id: args.locationId,
    entry_date: args.entryDate,
    entry_type: args.entry.entryType,
    memo: args.entry.memo,
    source_module: args.sourceModule ?? 'MONEY_MOVEMENT',
    source_ref: args.sourceId, // Stripe pi_/po_ id — external string, not a uuid
    created_by: args.createdBy,
    lines: args.entry.lines,
  });
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
