/**
 * Onboarding conversion — server-side session helpers.
 *
 * A conversion session is staged as a `public.ai_decisions` row (feature
 * CONVERSION_MAP, kind ONBOARDING_CONVERSION): its `proposed_output` JSON holds the
 * uploaded source lines, the proposed/edited mapping, and the assembled opening
 * trial balance. This REUSES the existing AI-decision staging table — no new
 * migration this wave — and inherits its RLS (org isolation) and audit fields.
 * On go-live the row flips to APPROVED and links to the opening GL entry it posted.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONVERSION_FEATURE,
  CONVERSION_KIND,
  type ConversionSessionData,
  type TargetAccount,
} from './conversion';

export interface ConversionSessionRow {
  id: string;
  status: string;
  data: ConversionSessionData;
  postedGlEntryId: string | null;
  createdAt: string;
}

/** All active tenant accounts as mapping targets (number + name). */
export async function loadTargetAccounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<TargetAccount[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('account_number, name, account_type')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('account_number');
  if (error) throw new Error(`Could not load the chart of accounts: ${error.message}`);
  return (data ?? []).map((a) => ({
    accountNumber: String((a as { account_number: string }).account_number),
    name: String((a as { name: string }).name),
    accountType: (a as { account_type: string | null }).account_type ?? null,
  }));
}

/** Map of active account number -> id, for resolving opening lines to accounts. */
export async function loadAccountIdByNumber(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, account_number')
    .eq('org_id', orgId)
    .eq('is_active', true);
  if (error) throw new Error(`Could not load accounts: ${error.message}`);
  return new Map(
    (data ?? []).map((a) => [
      String((a as { account_number: string }).account_number),
      String((a as { id: string }).id),
    ]),
  );
}

/** Load one conversion session, RLS-scoped. Returns null when not found. */
export async function loadSession(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<ConversionSessionRow | null> {
  const { data, error } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output, posted_gl_entry_id, created_at, feature')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    status: string;
    proposed_output: unknown;
    posted_gl_entry_id: string | null;
    created_at: string;
    feature: string;
  };
  const parsed = row.proposed_output as ConversionSessionData | null;
  if (!parsed || parsed.kind !== CONVERSION_KIND) return null;
  return {
    id: row.id,
    status: row.status,
    data: parsed,
    postedGlEntryId: row.posted_gl_entry_id,
    createdAt: row.created_at,
  };
}

/** List conversion sessions for the org (most recent first). */
export async function listSessions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Array<{ id: string; status: string; companyShortCode: string; asOfDate: string; balanced: boolean; tiedOut: boolean; posted: boolean; createdAt: string }>> {
  const { data } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output, posted_gl_entry_id, created_at')
    .eq('org_id', orgId)
    .eq('feature', CONVERSION_FEATURE)
    .order('created_at', { ascending: false })
    .limit(50);
  const out: Array<{ id: string; status: string; companyShortCode: string; asOfDate: string; balanced: boolean; tiedOut: boolean; posted: boolean; createdAt: string }> = [];
  for (const r of (data ?? []) as Array<{ id: string; status: string; proposed_output: ConversionSessionData | null; posted_gl_entry_id: string | null; created_at: string }>) {
    const d = r.proposed_output;
    if (!d || d.kind !== CONVERSION_KIND) continue;
    out.push({
      id: r.id,
      status: r.status,
      companyShortCode: d.companyShortCode,
      asOfDate: d.asOfDate,
      balanced: d.balance.balanced,
      tiedOut: d.tiedOut,
      posted: !!r.posted_gl_entry_id,
      createdAt: r.created_at,
    });
  }
  return out;
}

/** Persist an updated session data blob back onto its ai_decisions row. */
export async function saveSessionData(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
  data: ConversionSessionData,
): Promise<void> {
  const { error } = await supabase
    .from('ai_decisions')
    .update({ proposed_output: data })
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) throw new Error(`Could not save the conversion session: ${error.message}`);
}

/** Deterministic source_ref for the opening entry — the double-post guard. */
export function openingSourceRef(sessionId: string): string {
  return `CONVERSION-${sessionId}`;
}
