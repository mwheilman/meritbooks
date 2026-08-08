export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getErpConnector } from '@/lib/integrations/erp/catalog';
import { upsertErpConnection, type ErpConnectionStatus } from '@/lib/integrations/erp/connection';

/**
 * POST /api/integrations/erp/connect
 *
 * "Start connect" per connection method. Per-ERP SYNC is future — this records
 * INTENT and scaffolds the per-method handshake shape:
 *
 *  - CSV        → route the user into the existing /import pipeline (records a
 *                 pending intent so the connection shows in the list).
 *  - MANUAL     → mark connected immediately (there is no external system).
 *  - REQUEST    → record the requested ERP name for follow-up.
 *  - OAUTH /    → PLACEHOLDER: record a pending intent and return the redirect/
 *    AGGREGATOR / handshake SHAPE (authorizeUrl null = "coming soon"), so the UI
 *    NATIVE_API/  flow is wired end-to-end without a real credential exchange.
 *    WEBHOOK
 *
 * GATE: settings_system:edit (system/integration setting). Writes go through the
 * admin client AFTER the gate — the same pattern as membership_invitations — so they
 * work before the authenticated-insert RLS policy is relied upon. Degrade-safe: if
 * the table is unprovisioned, the intent simply isn't recorded (recorded:false).
 */

const bodySchema = z.object({
  erpId: z.string().min(1).max(64),
  /** Human label for the linked account (optional; shown in the connection list). */
  externalAccountLabel: z.string().trim().max(200).optional(),
  /** Required when requesting an unlisted ERP. */
  requestedName: z.string().trim().max(120).optional(),
});

export async function POST(request: Request) {
  // 1. Identity (userId for the gate + audit).
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const { userId } = authRes;

  // 2. Gate: settings_system:edit. Returns the RESOLVED org (no first-org fallback).
  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  // 3. Validate body.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }
  const { erpId, externalAccountLabel, requestedName } = parsed.data;

  // 4. Resolve the connector from the SERVER catalog (method is server-authoritative).
  const connector = getErpConnector(erpId);
  if (!connector) {
    return NextResponse.json({ error: 'Unknown connector', code: 'NOT_FOUND' }, { status: 404 });
  }

  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const admin = createAdminSupabase();

  const method = connector.connectionMethod;
  const isRequest = connector.status === 'REQUEST';

  // A request for an unlisted ERP needs a name.
  if (isRequest && !requestedName) {
    return NextResponse.json(
      { error: 'Tell us the name of the system you use.', code: 'REQUESTED_NAME_REQUIRED' },
      { status: 422 },
    );
  }

  // 5. Decide the recorded status + response action per method.
  let status: ErpConnectionStatus = 'pending';
  let markConnected = false;
  const meta: Record<string, unknown> = {};
  let action: 'redirect' | 'requested' | 'connected' | 'coming_soon' = 'coming_soon';
  let href: string | null = null;
  // Scaffolded handshake shape for OAUTH/AGGREGATOR — real values arrive when sync
  // is built. `authorizeUrl:null` signals "coming soon" to the client.
  let handshake: { kind: 'oauth' | 'aggregator'; authorizeUrl: string | null } | null = null;

  if (isRequest) {
    action = 'requested';
    meta.requestedName = requestedName;
    meta.requestedBy = userId;
  } else if (method === 'CSV') {
    action = 'redirect';
    href = '/import';
    meta.via = 'csv';
  } else if (method === 'MANUAL') {
    action = 'connected';
    status = 'connected';
    markConnected = true;
    meta.via = 'manual';
  } else {
    // NATIVE_API / OAUTH / AGGREGATOR / WEBHOOK — placeholder handshake.
    action = 'coming_soon';
    meta.intent = 'coming_soon';
    if (method === 'OAUTH') handshake = { kind: 'oauth', authorizeUrl: null };
    if (method === 'AGGREGATOR') handshake = { kind: 'aggregator', authorizeUrl: null };
  }

  // 6. Record intent (best-effort / degrade-safe). Never store a secret here.
  let recorded = false;
  try {
    const res = await upsertErpConnection(admin, {
      orgId,
      erpId,
      method,
      status,
      externalAccountLabel: externalAccountLabel ?? null,
      meta,
      markConnected,
    });
    recorded = res.recorded;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record connection', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action,
    href,
    handshake,
    recorded,
    status,
    erpId,
  });
}
