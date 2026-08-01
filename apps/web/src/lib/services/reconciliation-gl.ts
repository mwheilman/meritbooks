import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Compute a bank account's GL cash balance (the BOOK side of a reconciliation)
 * as of a period-end date: Σ(debit) − Σ(credit) over POSTED gl_entries dated
 * on/before `endDate`, for the bank account's GL cash `account_id` + location.
 *
 * Server-side and authoritative — never trust a client-supplied book balance.
 * Centralized here so the statement reconciliation, the draft-start path, and
 * the autopilot read model all compute the book balance identically (no drift).
 * All cents are bigint; the caller passes an RLS-scoped client so org isolation
 * is enforced by the database.
 */
export async function computeGlCashBalanceCents(
  supabase: SupabaseClient,
  args: { orgId: string; locationId: string; accountId: string; endDate: string },
): Promise<number> {
  const { data: postedEntries } = await supabase
    .from('gl_entries')
    .select('id')
    .eq('org_id', args.orgId)
    .eq('location_id', args.locationId)
    .eq('status', 'POSTED')
    .lte('entry_date', args.endDate);

  const ids = (postedEntries ?? []).map((e) => (e as { id: string }).id);
  if (ids.length === 0) return 0;

  let balanceCents = 0;
  // Chunk the IN() list for accounts with long histories.
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: lines } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .eq('account_id', args.accountId)
      .in('gl_entry_id', slice);
    for (const l of lines ?? []) {
      const row = l as { debit_cents: number | string | null; credit_cents: number | string | null };
      balanceCents += Number(row.debit_cents ?? 0) - Number(row.credit_cents ?? 0);
    }
  }
  return balanceCents;
}
