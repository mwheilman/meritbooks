export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import {
  listCapabilityStatus,
  connectProvider,
  disconnectProvider,
  CapabilityNotEntitledError,
} from '@/lib/money/connections';
import type { Capability, ProviderEnvironment } from '@/lib/money/providers/types';

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
 */

const CAPS: Capability[] = ['AR_COLLECTION', 'AP_DISBURSEMENT', 'PAYROLL', 'BANK_FEED'];
const ENVS: ProviderEnvironment[] = ['test', 'live'];

export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    const status = await listCapabilityStatus(supabase, orgId);
    return NextResponse.json({ ok: true, capabilities: status });
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
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
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
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    await disconnectProvider(supabase, orgId, parsed.data.connection_id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

// Avoid unused-import warnings for exported-type-only references in some TS configs.
void CAPS;
void ENVS;
