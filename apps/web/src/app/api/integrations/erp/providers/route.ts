export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  MIGRATION_PROVIDERS,
  describeProviderEntities,
  RealConnectorProvider,
} from '@/lib/integrations/erp/providers';

/**
 * GET /api/integrations/erp/providers
 *
 * Lists the direct-API MIGRATION sources (QuickBooks Online / Xero / Sage) a tenant
 * can pull their prior books from, with: the importable entities (and the source
 * field names each maps from), whether a fixture is available for an end-to-end
 * "Preview import", and whether live OAuth credentials are configured for this
 * deployment. Credential presence is a boolean only — no secret is ever returned.
 *
 * GATE: settings_system:view (integration setting; fails closed). Degrade-safe: with
 * no credentials configured, `credentialsConfigured:false` and the UI offers the
 * fixture preview + an OAuth "connect" stub that explains credentials are needed.
 */
export async function GET() {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const { userId } = authRes;

  const guard = await requirePermission(userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  const providers = MIGRATION_PROVIDERS.map((p) => {
    const real = new RealConnectorProvider(p.id);
    return {
      id: p.id,
      name: p.name,
      authType: p.authType,
      catalogId: p.catalogId,
      description: p.description,
      fixtureAvailable: p.fixtureAvailable,
      credentialsConfigured: real.hasCredentials(),
      openingBalanceEntity: p.openingBalanceEntity,
      entities: describeProviderEntities(p.id),
    };
  });

  return NextResponse.json({ providers });
}
