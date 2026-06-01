export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  getSandboxStatus,
  seedSandbox,
  resetSandbox,
  runSandboxRoundTrip,
} from '@/lib/services/sandbox';

/** GET /api/sandbox — current sandbox status (entities, master-data counts, periods). */
export async function GET() {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminSupabase();
  try {
    const status = await getSandboxStatus(supabase);
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Status failed' }, { status: 500 });
  }
}

/**
 * POST /api/sandbox { action: 'seed' | 'reset' | 'verify' }
 *  - seed:   idempotent seed/repair (COA via real path + entities + master data + jobs)
 *  - reset:  clear transactional + master data, then re-seed
 *  - verify: run the four-path cross-module round-trip and report pass/fail
 */
export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let action: string | undefined;
  try {
    const body = await request.json();
    action = body?.action;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!action || !['seed', 'reset', 'verify'].includes(action)) {
    return NextResponse.json({ error: "action must be one of: 'seed', 'reset', 'verify'" }, { status: 422 });
  }

  const supabase = createAdminSupabase();
  try {
    if (action === 'seed') {
      const result = await seedSandbox(supabase);
      return NextResponse.json({ ok: true, action, ...result });
    }
    if (action === 'reset') {
      const result = await resetSandbox(supabase);
      return NextResponse.json({ ok: true, action, ...result });
    }
    // verify
    const status = await getSandboxStatus(supabase);
    if (!status.orgId) {
      return NextResponse.json({ error: 'No organization to verify — seed the sandbox first.' }, { status: 400 });
    }
    const roundTrip = await runSandboxRoundTrip(supabase, status.orgId);
    const fresh = await getSandboxStatus(supabase);
    return NextResponse.json({ ok: true, action, roundTrip, status: fresh });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : `${action} failed` }, { status: 500 });
  }
}
