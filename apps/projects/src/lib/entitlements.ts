import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export type Entitlements = Record<string, boolean>;

// Resolve the caller's org THROUGH the RLS-scoped client, i.e. via the database's
// get_org_id(). That function resolves an explicit `org_id` claim, Clerk's native
// active-org object (`o.id` -> clerk_org_id), OR — when the session carries no
// active org at all — the caller's single active employee seat (fail-closed).
// Reading the org row via RLS (which returns ONLY `id = get_org_id()`) keeps the
// gate, the dashboard, and every data query on the SAME resolution, so they can
// never disagree the way a narrower claim-only parse did.
export async function currentOrgId(): Promise<string | null> {
  const sb = await createAuthedServerSupabase();
  if (!sb) return null;
  const { data } = await sb
    .schema('core')
    .from('organizations')
    .select('id')
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// Reads core.organizations.entitlements for the caller's resolved org (RLS-scoped
// to get_org_id()). The optional argument is accepted for call-site compatibility
// but ignored — RLS already scopes the read to exactly the caller's org row.
export async function getEntitlements(_orgId?: string | null): Promise<Entitlements> {
  const sb = await createAuthedServerSupabase();
  if (!sb) return {};
  const { data } = await sb
    .schema('core')
    .from('organizations')
    .select('entitlements')
    .limit(1)
    .maybeSingle();
  return ((data?.entitlements as Entitlements) ?? {});
}

export function hasModule(ents: Entitlements, mod: string): boolean {
  return ents?.[mod] === true;
}
