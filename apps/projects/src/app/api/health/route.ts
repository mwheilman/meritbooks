export const dynamic = 'force-dynamic';

import { route, must } from '@/lib/api';

// Health probe: auth → Clerk token → RLS-scoped read of the caller's org, plus pm reachability.
export const GET = route({ access: 'none', mask: false }, async ({ db, tenant }) => {
  const org = must(await db.schema('core').from('organizations').select('id, entitlements').eq('id', tenant.orgId).maybeSingle(), 'health org');
  const pmRes = await db.schema('pm').from('pack_installs').select('id', { count: 'exact', head: true });
  return { ok: true, module: 'PROJECTS', orgId: tenant.orgId, entitlements: (org as { entitlements: unknown } | null)?.entitlements ?? null, pm: !pmRes.error };
});
