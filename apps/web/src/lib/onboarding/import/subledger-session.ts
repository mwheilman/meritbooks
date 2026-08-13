/**
 * Bridge from a committed AR/AP import into the conversion session's subledger detail.
 *
 * The extended go-live tie-out (lib/onboarding/reconciliation/build.ts →
 * buildGateSubledgerTies) reads `ConversionSessionData.subledgerDetail` and foots each
 * subledger total against its control account's OPENING balance (AR_CONTROL,
 * AP_CONTROL, …). For that gate to fire, the Customers/AR and Vendors/AP sections must
 * WRITE the Σ open AR / Σ open AP they committed onto the tenant's open conversion
 * session. This module does exactly that — find the latest un-posted conversion
 * session for a company and merge a subledger-detail patch into it.
 *
 * No schema change: `subledgerDetail` already rides inside the existing
 * `ai_decisions.proposed_output` JSON (see conversion.ts ImportedSubledgerDetail).
 * RLS-scoped (org). Degrade-safe: when there is no conversion session for the company
 * (e.g. a clean-start business with no opening trial balance), this reports "not
 * attached" and the caller still succeeds — the records were committed regardless.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONVERSION_FEATURE,
  CONVERSION_KIND,
  type ConversionSessionData,
  type ImportedSubledgerDetail,
} from '@/lib/onboarding/conversion';
import { saveSessionData } from '@/lib/onboarding/session';

export interface OpenConversionSession {
  id: string;
  data: ConversionSessionData;
}

/**
 * The most recent un-posted conversion session for `companyId`, or null. A posted
 * session is locked and must never be re-touched, so those are excluded.
 */
export async function findOpenConversionSession(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
): Promise<OpenConversionSession | null> {
  const { data, error } = await supabase
    .from('ai_decisions')
    .select('id, proposed_output, posted_gl_entry_id')
    .eq('org_id', orgId)
    .eq('feature', CONVERSION_FEATURE)
    .is('posted_gl_entry_id', null)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error || !data) return null;
  for (const row of data as Array<{ id: string; proposed_output: unknown; posted_gl_entry_id: string | null }>) {
    const parsed = row.proposed_output as ConversionSessionData | null;
    if (parsed && parsed.kind === CONVERSION_KIND && parsed.companyId === companyId) {
      return { id: row.id, data: parsed };
    }
  }
  return null;
}

/**
 * Merge a subledger-detail patch into the company's open conversion session so the
 * extended tie-out gate + Conversion Reconciliation report light up. Returns whether a
 * session was found and updated. Never throws on "no session" — that path is expected
 * (clean start / opening not yet staged).
 */
export async function attachSubledgerDetail(
  supabase: SupabaseClient,
  orgId: string,
  companyId: string,
  patch: Partial<ImportedSubledgerDetail>,
): Promise<{ attached: boolean; sessionId: string | null }> {
  const session = await findOpenConversionSession(supabase, orgId, companyId);
  if (!session) return { attached: false, sessionId: null };

  const next: ConversionSessionData = {
    ...session.data,
    subledgerDetail: { ...(session.data.subledgerDetail ?? {}), ...patch },
  };
  await saveSessionData(supabase, orgId, session.id, next);
  return { attached: true, sessionId: session.id };
}
