import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Bank-feed vendor resolution (audit 06 §5 bug 1).
 *
 * The edit panel lets the reviewer type a vendor name. Before this fix the
 * typed name was never sent, so an edit was silently discarded on Save &
 * Approve. The name is now sent as `vendor_name` and resolved here:
 *
 *  - blank / unchanged from the AI-suggested vendor → keep the suggested id
 *  - otherwise → match an existing org vendor by name or display_name
 *    (case/whitespace-insensitive), else create a new vendor master record.
 *
 * Editing the payee on a transaction re-points the transaction; it never
 * renames the vendor master (that's the Vendors page's job).
 */

export interface CurrentVendor {
  id: string;
  name: string;
  display_name: string | null;
}

export type VendorDecision =
  | { kind: 'keep'; vendorId: string | null }
  | { kind: 'resolve'; name: string };

/** Collapse whitespace and trim; returns '' for nullish. */
export function cleanVendorName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export function sameVendorName(a: string | null | undefined, b: string | null | undefined): boolean {
  return cleanVendorName(a).toLowerCase() === cleanVendorName(b).toLowerCase();
}

/**
 * Decide what to do with a submitted vendor name given the vendor id the
 * client sent and (if any) that vendor's record.
 */
export function decideVendor(
  submittedName: string | null | undefined,
  submittedVendorId: string | null | undefined,
  current: CurrentVendor | null,
): VendorDecision {
  const name = cleanVendorName(submittedName);
  const fallbackId = submittedVendorId ?? null;
  if (!name) return { kind: 'keep', vendorId: fallbackId };
  if (current && (sameVendorName(name, current.name) || sameVendorName(name, current.display_name))) {
    return { kind: 'keep', vendorId: current.id };
  }
  return { kind: 'resolve', name };
}

/** Escape LIKE wildcards so a vendor name is matched literally by ilike. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Find-or-create a vendor by name in the caller's org (RLS-scoped client).
 * Returns the vendor id, or throws with a readable message.
 */
export async function resolveVendorIdByName(
  supabase: SupabaseClient,
  orgId: string,
  name: string,
  createdBy?: string | null,
): Promise<{ id: string; created: boolean }> {
  const clean = cleanVendorName(name);
  const pattern = escapeLike(clean);

  // Two literal (wildcard-escaped) ilike lookups rather than one `or=` filter,
  // so names containing , ( ) " need no PostgREST quoting.
  const cols = 'id, name, display_name, is_active';
  const [byName, byDisplay] = await Promise.all([
    supabase.schema('core').from('vendors').select(cols).eq('org_id', orgId).is('deleted_at', null).ilike('name', pattern).limit(5),
    supabase.schema('core').from('vendors').select(cols).eq('org_id', orgId).is('deleted_at', null).ilike('display_name', pattern).limit(5),
  ]);
  const findErr = byName.error ?? byDisplay.error;
  if (findErr) throw new Error(`Vendor lookup failed: ${findErr.message}`);

  const rows = [...(byName.data ?? []), ...(byDisplay.data ?? [])] as Array<{
    id: string;
    name: string;
    display_name: string | null;
    is_active: boolean;
  }>;
  const exact =
    rows.find((r) => r.is_active && (sameVendorName(r.name, clean) || sameVendorName(r.display_name, clean))) ??
    rows.find((r) => sameVendorName(r.name, clean) || sameVendorName(r.display_name, clean));
  if (exact) return { id: exact.id, created: false };

  const { data: created, error: insErr } = await supabase
    .schema('core')
    .from('vendors')
    .insert({ org_id: orgId, name: clean, display_name: clean, created_by: createdBy ?? null })
    .select('id')
    .single();
  if (insErr || !created) throw new Error(`Could not create vendor "${clean}": ${insErr?.message ?? 'unknown error'}`);
  return { id: (created as { id: string }).id, created: true };
}
