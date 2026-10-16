export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getQboConfigStatus } from '@/lib/integrations/erp/quickbooks/config';
import { loadQboConnection } from '@/lib/integrations/erp/quickbooks/connection-store';
import { isMissingErpTableError } from '@/lib/integrations/erp/connection';

/**
 * GET /api/integrations/erp/quickbooks/status
 *
 * What the onboarding "Where do your books live?" tile needs to render honestly:
 *   configured   — the platform has Intuit app keys (else show guided export)
 *   connected    — this org has a live QBO link
 *   status       — 'connected' | 'error' | 'not_connected'
 *   companyName, connectedAt, lastSyncAt, environment
 *   message      — plain-English error when status is 'error' (e.g. "reconnect")
 *   connectUrl   — where to send the browser to (re)connect
 *
 * Never returns a token, a Vault reference, or the realmId. GATE: settings_system:view.
 */
export async function GET() {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const guard = await requirePermission(authRes.userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  const cfg = getQboConfigStatus();
  const base = {
    configured: cfg.configured,
    environment: cfg.configured ? cfg.config.environment : null,
    connectUrl: '/api/integrations/erp/quickbooks/connect',
    notConfiguredReason: cfg.configured ? null : cfg.reason,
  };
  if (!cfg.configured) {
    return NextResponse.json({ ...base, connected: false, status: 'not_connected' });
  }

  const { createAdminSupabase } = await import('@/lib/supabase/server');
  try {
    const rec = await loadQboConnection(createAdminSupabase(), guard.orgId);
    if (!rec || !rec.meta) {
      return NextResponse.json({ ...base, connected: false, status: 'not_connected' });
    }
    return NextResponse.json({
      ...base,
      connected: rec.status === 'connected',
      status: rec.status === 'connected' ? 'connected' : rec.status === 'error' ? 'error' : 'not_connected',
      companyName: rec.companyName,
      connectedAt: rec.connectedAt,
      lastSyncAt: rec.lastSyncAt,
      message: rec.status === 'error' ? rec.meta.lastError : null,
      reconnectBy: rec.meta.refreshExpiresAt,
    });
  } catch (err) {
    if (isMissingErpTableError(err)) {
      return NextResponse.json({ ...base, connected: false, status: 'not_connected' });
    }
    return NextResponse.json(
      { ...base, connected: false, status: 'not_connected', error: 'Could not load the QuickBooks connection.' },
      { status: 500 },
    );
  }
}
