export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { ERP_CATALOG } from '@/lib/integrations/erp/catalog';
import { listErpConnections } from '@/lib/integrations/erp/connection';

/**
 * GET /api/integrations/erp
 *
 * Returns the connector CATALOG (static, provider-agnostic) plus THIS tenant's
 * connection status. RLS scopes connections to the caller's org via the user-scoped
 * client. Degrade-safe: if the `core.erp_connections` table is not provisioned yet,
 * `provisioned:false` and an empty connection list come back — the UI still renders
 * the catalog and the always-available CSV/skip paths.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  try {
    const { provisioned, connections } = await listErpConnections(supabase, orgId);
    return NextResponse.json({
      catalog: ERP_CATALOG,
      connections,
      provisioned,
    });
  } catch (err) {
    // A real (non-missing-table) failure — surface it; the client shows an error
    // state but the catalog itself is static and could still render if desired.
    return NextResponse.json(
      {
        catalog: ERP_CATALOG,
        connections: [],
        provisioned: false,
        error: err instanceof Error ? err.message : 'Failed to load ERP connections',
      },
      { status: 500 },
    );
  }
}
