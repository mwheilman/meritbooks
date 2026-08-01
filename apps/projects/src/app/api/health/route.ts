import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';

// Health probe: confirms end-to-end auth -> Clerk token -> RLS-scoped DB read of
// the caller's own org (core.organizations is REST-exposed + org-readable).
export const GET = apiQueryHandler(null, async (_params, { orgId, supabase }) => {
  const { data, error } = await supabase
    .schema('core')
    .from('organizations')
    .select('id, entitlements')
    .eq('id', orgId)
    .maybeSingle();
  return NextResponse.json({
    ok: !error,
    module: 'PROJECTS',
    orgId,
    entitlements: data?.entitlements ?? null,
    error: error?.message ?? null,
  });
});
