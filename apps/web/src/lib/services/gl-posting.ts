import { SupabaseClient } from '@supabase/supabase-js';

export interface JournalEntryLineInput {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  location_id: string;
  department_id?: string;
  class_id?: string;
  item_id?: string;
  memo?: string;
  quantity?: number;
  unit_cost_cents?: number;
}

export interface PostJournalEntryInput {
  org_id: string;
  location_id: string;
  entry_date: string;
  entry_type?: string;
  memo?: string;
  source_module?: string;
  source_id?: string;
  created_by: string;
  lines: JournalEntryLineInput[];
}

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
      source_id: input.source_id,
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

  // Insert all lines
  const lineInserts = input.lines.map((line, index) => ({
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
    memo: line.memo ?? null,
    quantity: line.quantity ?? null,
    unit_cost_cents: line.unit_cost_cents ?? null,
  }));

  const { error: linesError } = await supabase
    .from('gl_entry_lines')
    .insert(lineInserts);

  if (linesError) {
    await supabase.from('gl_entries').delete().eq('id', entry.id);
    return { success: false, error: `Failed to post lines: ${linesError.message}` };
  }

  return { success: true, entry_id: entry.id, entry_number: entry.entry_number };
}

/** Raw GL line from Supabase query (before mapping to JournalEntryLineInput) */
interface RawGlLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  location_id?: string;
  department_id?: string | null;
  class_id?: string | null;
  item_id?: string | null;
  memo?: string | null;
  [key: string]: unknown;
}

/**
 * Void a posted journal entry.
 */
export async function voidJournalEntry(
  supabase: SupabaseClient,
  orgId: string,
  entryId: string,
  userId: string,
  reason: string
): Promise<PostResult> {
  const { data: original, error: fetchError } = await supabase
    .from('gl_entries')
    .select(`*, gl_entry_lines (*)`)
    .eq('id', entryId)
    .eq('org_id', orgId)
    .single();

  if (fetchError || !original) {
    return { success: false, error: 'Entry not found' };
  }
  if (original.status !== 'POSTED') {
    return { success: false, error: `Cannot void entry in status ${original.status}` };
  }

  const rawLines = original.gl_entry_lines as RawGlLine[];
  const reversingLines: JournalEntryLineInput[] = rawLines.map((line) => ({
    account_id: line.account_id,
    debit_cents: line.credit_cents,
    credit_cents: line.debit_cents,
    location_id: (line.location_id as string) ?? original.location_id,
    department_id: (line.department_id as string) ?? undefined,
    class_id: (line.class_id as string) ?? undefined,
    item_id: (line.item_id as string) ?? undefined,
    memo: `VOID: ${(line.memo as string) ?? ''}`,
  }));

  const result = await postJournalEntry(supabase, {
    org_id: orgId,
    location_id: original.location_id,
    entry_date: new Date().toISOString().split('T')[0],
    entry_type: 'REVERSING',
    memo: `VOID of ${original.entry_number}: ${reason}`,
    source_module: original.source_module,
    created_by: userId,
    lines: reversingLines,
  });

  if (!result.success) return result;

  await supabase
    .from('gl_entries')
    .update({
      status: 'VOIDED',
      voided_at: new Date().toISOString(),
      voided_by: userId,
      void_reason: reason,
      reversed_by_id: result.entry_id,
    })
    .eq('id', entryId);

  return result;
}
