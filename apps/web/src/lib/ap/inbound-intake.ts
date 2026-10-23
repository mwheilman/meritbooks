/**
 * Small, still-used helpers from the original (pre-2D) email-to-bill path.
 *
 * The inbound pipeline itself moved to lib/email/* (provider adapters, per-company
 * alias routing, the message log, dedupe) and lib/ap/inbound-email-ap.ts (the AP
 * handler) in Wave 2D — see docs/FPB-ap-intake.md. What remains here:
 *   • normalizeEmailAddress / slugFromInboundAddress — address helpers (tested);
 *   • resolveDefaultLocationId — where a mail to the LEGACY per-organization address
 *     (core.organizations.inbound_ap_address, migration 135) is filed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Normalize an email address for comparison (trim + lowercase, strip display name). */
export function normalizeEmailAddress(raw: string): string {
  const s = (raw ?? '').trim();
  const angle = s.match(/<([^>]+)>/);
  return (angle ? angle[1] : s).trim().toLowerCase();
}

/** Extract the `<slug>` from an `ap-<slug>@…` or `ap+<slug>@…` inbound localpart. */
export function slugFromInboundAddress(address: string): string | null {
  const addr = normalizeEmailAddress(address);
  const local = addr.split('@')[0] ?? '';
  const m = local.match(/^ap[-+](.+)$/);
  return m ? m[1] : null;
}

/**
 * The default company for mail sent to the legacy organization address. Prefers an
 * active operating company over the management company; '' when the org has none.
 * The reviewer can change the company before approving the draft.
 */
export async function resolveDefaultLocationId(admin: SupabaseClient, orgId: string): Promise<string> {
  const { data: op } = await admin
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .eq('is_management_company', false)
    .order('name')
    .limit(1);
  const opRow = (op as Array<{ id: string }> | null)?.[0];
  if (opRow) return opRow.id;

  const { data: anyRow } = await admin
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name')
    .limit(1);
  return (anyRow as Array<{ id: string }> | null)?.[0]?.id ?? '';
}
