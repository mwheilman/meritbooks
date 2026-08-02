/**
 * Tenant resolution (identity gate #9) — the app-layer mirror of the database
 * `public.get_org_id()` (migration 087).
 *
 * With Clerk organizations enabled, the session `org_id` claim can be EITHER a
 * MeritBooks tenant uuid (custom JWT template — the current live behavior) OR a raw
 * Clerk org id ('org_XXXX'). Server code that runs on the ADMIN (RLS-bypassing)
 * client cannot rely on RLS to scope its queries, so it must resolve the claim to
 * the real Books tenant uuid itself — and FAIL CLOSED (return null) when the claim
 * maps to no tenant, rather than falling back to an arbitrary "first org".
 *
 * This is the one place that mapping lives, so route/guard/posting code never
 * re-derives it (or re-introduces a first-org fallback).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Canonical v4-shaped uuid matcher (same shape get_org_id() guards its cast with). */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolve a session `org_id` claim to the MeritBooks tenant uuid, or null.
 *
 * - A uuid-shaped claim is passed through (RLS's get_org_id() is the authoritative
 *   existence check; the claim is Clerk-signed and un-forgeable, so a cheap
 *   passthrough is safe and avoids a per-request roundtrip for the common case).
 * - A non-uuid claim is treated as a Clerk org id and mapped via
 *   core.organizations.clerk_org_id using the supplied client.
 * - An absent/empty claim, or an unmapped Clerk id, resolves to null (fail closed).
 *
 * @param claimOrgId the raw `org_id` session claim (Books uuid or Clerk org id)
 * @param adminDb    a Supabase client able to read core.organizations (typically the
 *                   admin/service-role client, since the mapping must work even
 *                   before RLS can see the row)
 */
export async function resolveTenantOrgId(
  claimOrgId: string | null | undefined,
  adminDb: SupabaseClient,
): Promise<string | null> {
  const claim = typeof claimOrgId === 'string' ? claimOrgId.trim() : '';
  if (claim.length === 0) return null;

  // Case 1: already a Books tenant uuid — passthrough (RLS verifies existence).
  if (UUID_RE.test(claim)) return claim;

  // Case 2: a Clerk org id -> the bound Books tenant.
  const { data, error } = await adminDb
    .schema('core')
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', claim)
    .maybeSingle();
  if (error || !data?.id) return null; // unmapped / lookup error -> fail closed
  return data.id as string;
}

/**
 * Bind the caller's Clerk organization to the single existing Books tenant on first
 * authenticated login, so no manual id entry is ever required and subsequent
 * requests resolve via get_org_id()/resolveTenantOrgId().
 *
 * Preconditions (both known at /api/me time): the Clerk NATIVE org id (auth().orgId,
 * an 'org_XXXX' string) and the caller's resolved Books tenant (org.id). If the
 * Books tenant already carries a clerk_org_id, or this Clerk org is already bound to
 * ANY tenant, we do nothing — we never rebind a Clerk org to a second tenant (that
 * would break isolation). The DB unique index uq_org_clerk_org_id is the final
 * guarantor: a racing bind to an already-used clerk id errors, and we swallow it.
 *
 * Best-effort and fail-safe: any error is logged and swallowed so login proceeds.
 */
export async function bindClerkOrgOnLogin(params: {
  clerkOrgId: string | null | undefined;
  booksOrgId: string;
  admin: SupabaseClient;
}): Promise<void> {
  const { clerkOrgId, booksOrgId, admin } = params;
  if (typeof clerkOrgId !== 'string' || clerkOrgId.trim().length === 0) return;
  const clerkId = clerkOrgId.trim();

  try {
    // Is this Clerk org already bound to some tenant?
    const { data: bound } = await admin
      .schema('core')
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', clerkId)
      .maybeSingle();
    if (bound?.id) {
      if (bound.id !== booksOrgId) {
        console.error(
          '[bindClerkOrgOnLogin] Clerk org already bound to a different tenant; refusing to rebind',
        );
      }
      return; // already bound (to this tenant or another) -> nothing to do
    }

    // Does this Books tenant already carry a (different) Clerk binding? Never overwrite.
    const { data: org } = await admin
      .schema('core')
      .from('organizations')
      .select('id, clerk_org_id')
      .eq('id', booksOrgId)
      .maybeSingle();
    if (!org?.id || org.clerk_org_id) return;

    // Bind, guarding the race with a conditional update (only while still null). The
    // unique index rejects a concurrent bind of the same clerk id to another tenant.
    const { error } = await admin
      .schema('core')
      .from('organizations')
      .update({ clerk_org_id: clerkId })
      .eq('id', booksOrgId)
      .is('clerk_org_id', null);
    if (error) {
      console.error('[bindClerkOrgOnLogin] bind failed:', error.message);
    }
  } catch (e) {
    console.error('[bindClerkOrgOnLogin] failed:', e instanceof Error ? e.message : e);
  }
}
