export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  listCapabilityStatus,
  connectProvider,
  disconnectProvider,
  CapabilityNotEntitledError,
} from '@/lib/money/connections';
import type { Capability, ProviderEnvironment } from '@/lib/money/providers/types';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET  /api/integrations/connections
 *   -> per-capability status (entitled? connected? ready?) for the tenant.
 *
 * POST /api/integrations/connections
 *   { capability, provider, environment, account_handle?, secret?, metadata? }
 *   -> register/connect a provider (entitlement-gated; secret stored in Vault).
 *
 * PATCH /api/integrations/connections
 *   { connection_id, action: 'disconnect' }
 *
 * Secrets are write-only here and never returned. Connecting requires the
 * capability's entitlement to be set on the tenant (Core ruling).
 *
 * ORG RESOLUTION (06 §L.3 L2): the tenant comes from requireAuthedContext() — the same
 * caller-org resolution as the rest of the app (explicit `org_id` claim OR Clerk's
 * native `o.id`). An unresolved org fails CLOSED with 400 (it used to 500).
 */

const CAPS: Capability[] = ['AR_COLLECTION', 'AP_DISBURSEMENT', 'PAYROLL', 'BANK_FEED'];
const ENVS: ProviderEnvironment[] = ['test', 'live'];

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  try {
    // Status read runs AS THE USER (RLS on core.provider_connections + organizations);
    // the helpers also scope every query to orgId.
    const status = await listCapabilityStatus(ctx.supabase, orgId);
    // Never return a Vault secret reference to the browser (the POST already strips it).
    const capabilities = status.map((cap) => ({
      ...cap,
      connections: cap.connections.map(({ secretRef: _omit, ...safe }) => {
        void _omit;
        return safe;
      }),
    }));
    return NextResponse.json({ ok: true, capabilities });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

const postSchema = z.object({
  capability: z.enum(['AR_COLLECTION', 'AP_DISBURSEMENT', 'PAYROLL', 'BANK_FEED']),
  provider: z.string().min(1).max(64),
  environment: z.enum(['test', 'live']),
  account_handle: z.string().max(256).nullable().optional(),
  secret: z.string().min(1).max(8192).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Authorize — connecting/disconnecting a provider (secrets in Vault) is a
  // system-integration setting; same gate as erp/connect and payments/connect.
  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  // Vault secret writes/deletes are service-role only; scoped to the caller's resolved tenant.
  const supabase = createAdminSupabase();
  try {
    const conn = await connectProvider(supabase, orgId, {
      capability: parsed.data.capability,
      provider: parsed.data.provider,
      environment: parsed.data.environment,
      accountHandle: parsed.data.account_handle ?? null,
      secret: parsed.data.secret ?? null,
      connectedBy: userId,
      metadata: parsed.data.metadata,
    });
    // Never return the secret_ref to the client.
    const { secretRef: _omit, ...safe } = conn;
    void _omit;
    return NextResponse.json({ ok: true, connection: safe });
  } catch (e) {
    if (e instanceof CapabilityNotEntitledError) return NextResponse.json({ error: e.message }, { status: 403 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

const patchSchema = z.object({
  connection_id: z.string().uuid(),
  action: z.literal('disconnect'),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Authorize — connecting/disconnecting a provider (secrets in Vault) is a
  // system-integration setting; same gate as erp/connect and payments/connect.
  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  // Vault secret writes/deletes are service-role only; scoped to the caller's resolved tenant.
  const supabase = createAdminSupabase();
  try {
    await disconnectProvider(supabase, orgId, parsed.data.connection_id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

// Avoid unused-import warnings for exported-type-only references in some TS configs.
void CAPS;
void ENVS;
