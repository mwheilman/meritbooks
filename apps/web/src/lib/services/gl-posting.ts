import { SupabaseClient } from '@supabase/supabase-js';

export interface JournalEntryLineInput {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  location_id: string;
  department_id?: string;
  class_id?: string;
  item_id?: string;
  job_id?: string;
  memo?: string;
  quantity?: number;
  unit_cost_cents?: number;
  /** Counterparty entity (location) for intercompany due-to/due-from pairing. */
  counterparty_location_id?: string;
  /** Counterparty department for inter-department elimination pairing. */
  counterparty_department_id?: string;
}

export interface PostJournalEntryInput {
  org_id: string;
  location_id: string;
  entry_date: string;
  entry_type?: string;
  memo?: string;
  source_module?: string;
  /** Internal uuid reference (a bill id, an invoice id). Must be a uuid. */
  source_id?: string;
  /** External/string reference (Stripe pi_/po_ id, Plaid txn id). */
  source_ref?: string;
  created_by: string | null;
  lines: JournalEntryLineInput[];
}

/** A source_id must be a real uuid; anything else is an external ref. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostResult {
  success: boolean;
  entry_id?: string;
  entry_number?: string;
  error?: string;
}

/**
 * Post a journal entry to the GL.
 */
export async function postJournalEntry(
  supabase: SupabaseClient,
  input: PostJournalEntryInput
): Promise<PostResult> {
  const totalDebits = input.lines.reduce((sum, l) => sum + l.debit_cents, 0);
  const totalCredits = input.lines.reduce((sum, l) => sum + l.credit_cents, 0);

  if (totalDebits !== totalCredits) {
    return { success: false, error: `Unbalanced entry: debits=${totalDebits} credits=${totalCredits}` };
  }
  if (totalDebits === 0) {
    return { success: false, error: 'Entry has no amounts' };
  }
  if (input.lines.length < 2) {
    return { success: false, error: 'Entry must have at least 2 lines' };
  }

  // Find the fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', input.org_id)
    .eq('location_id', input.location_id)
    .lte('start_date', input.entry_date)
    .gte('end_date', input.entry_date)
    .single();

  if (periodError || !period) {
    return { success: false, error: `No fiscal period found for date ${input.entry_date}` };
  }
  if (period.status === 'HARD_CLOSE') {
    return { success: false, error: 'Cannot post to a hard-closed period' };
  }

  // Insert the journal entry header
  const { data: entry, error: entryError } = await supabase
    .from('gl_entries')
    .insert({
      org_id: input.org_id,
      location_id: input.location_id,
      entry_date: input.entry_date,
      entry_type: input.entry_type ?? 'STANDARD',
      fiscal_period_id: period.id,
      memo: input.memo,
      source_module: input.source_module ?? 'MANUAL',
      // Guard the uuid column: a source_id that isn't a valid uuid (e.g. a Stripe
      // 'pi_...' id passed by mistake) is rerouted to source_ref instead of
      // crashing the insert. This makes the whole class of "external id into uuid
      // column" bug impossible to reach the database, whatever a caller passes.
      source_id: input.source_id && UUID_RE.test(input.source_id) ? input.source_id : null,
      source_ref:
        input.source_ref ??
        (input.source_id && !UUID_RE.test(input.source_id) ? input.source_id : null),
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      posted_by: input.created_by,
      created_by: input.created_by,
    })
    .select('id, entry_number')
    .single();

  if (entryError || !entry) {
    return { success: false, error: `Failed to create entry: ${entryError?.message ?? 'unknown'}` };
  }

  // Insert all lines. Counterparty dimensions are included ONLY when provided,
  // so callers that don't use them never reference those columns — keeping
  // existing posting paths working regardless of whether migration 035
  // (counterparty_location_id) has been applied yet.
  const lineInserts = input.lines.map((line, index) => {
    const row: Record<string, unknown> = {
      org_id: input.org_id,
      gl_entry_id: entry.id,
      line_number: index + 1,
      account_id: line.account_id,
      debit_cents: line.debit_cents,
      credit_cents: line.credit_cents,
      location_id: line.location_id,
      department_id: line.department_id ?? null,
      class_id: line.class_id ?? null,
      item_id: line.item_id ?? null,
      job_id: line.job_id ?? null,
      memo: line.memo ?? null,
      quantity: line.quantity ?? null,
      unit_cost_cents: line.unit_cost_cents ?? null,
    };
    if (line.counterparty_location_id !== undefined) row.counterparty_location_id = line.counterparty_location_id;
    if (line.counterparty_department_id !== undefined) row.counterparty_department_id = line.counterparty_department_id;
    return row;
  });

  const { error: linesError } = await supabase
    .from('gl_entry_lines')
    .insert(lineInserts);

  if (linesError) {
    await supabase.from('gl_entries').delete().eq('id', entry.id);
    return { success: false, error: `Failed to post lines: ${linesError.message}` };
  }

  return { success: true, entry_id: entry.id, entry_number: entry.entry_number };
}

/**
 * Void a posted journal entry.
 *
 * The canonical reporting views (v_trial_balance / v_income_statement /
 * v_balance_sheet) count status='POSTED' only. So a void simply flips the entry
 * to VOIDED — its lines then drop out of every balance, netting the entry's
 * effect to zero. (The previous implementation ALSO posted a reversing entry,
 * which under POSTED-only views double-removed the amount, leaving −X instead
 * of 0.) Closed-period immutability is preserved: an entry in a hard-closed
 * period cannot be voided in place — reverse it with a new entry in an open
 * period instead.
 */
export async function voidJournalEntry(
  supabase: SupabaseClient,
  orgId: string,
  entryId: string,
  userId: string | null,
  reason: string
): Promise<PostResult> {
  const { data: original, error: fetchError } = await supabase
    .from('gl_entries')
    .select('id, status, entry_number, fiscal_period_id')
    .eq('id', entryId)
    .eq('org_id', orgId)
    .single();

  if (fetchError || !original) {
    return { success: false, error: 'Entry not found' };
  }
  if (original.status !== 'POSTED') {
    return { success: false, error: `Cannot void entry in status ${original.status}` };
  }

  // Closed-period immutability: do not mutate a hard-closed period.
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('status')
    .eq('id', original.fiscal_period_id)
    .maybeSingle();
  if (period?.status === 'HARD_CLOSE') {
    return {
      success: false,
      error: 'Cannot void an entry in a hard-closed period; post a reversing entry in an open period instead.',
    };
  }

  const { error: updateError } = await supabase
    .from('gl_entries')
    .update({
      status: 'VOIDED',
      voided_at: new Date().toISOString(),
      voided_by: userId,
      void_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)
    .eq('org_id', orgId);

  if (updateError) {
    return { success: false, error: `Failed to void entry: ${updateError.message}` };
  }

  return { success: true, entry_id: entryId, entry_number: original.entry_number as string };
}
