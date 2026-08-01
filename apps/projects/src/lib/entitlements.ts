import { auth } from '@clerk/nextjs/server';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export type Entitlements = Record<string, boolean>;

export async function currentOrgId(): Promise<string | null> {
  const { sessionClaims } = await auth();
  const claims = sessionClaims as Record<string, unknown> | null;
  return typeof claims?.org_id === 'string' ? claims.org_id : null;
}

// Reads core.organizations.entitlements for the current org (RLS-scoped).
// Suite Core owns entitlements; Projects only READS them to gate its surfaces.
export async function getEntitlements(orgId: string | null): Promise<Entitlements> {
  if (!orgId) return {};
  const sb = await createAuthedServerSupabase();
  if (!sb) return {};
  const { data } = await sb
    .schema('core')
    .from('organizations')
    .select('entitlements')
    .eq('id', orgId)
    .maybeSingle();
  return ((data?.entitlements as Entitlements) ?? {});
}

export function hasModule(ents: Entitlements, mod: string): boolean {
  return ents?.[mod] === true;
}
