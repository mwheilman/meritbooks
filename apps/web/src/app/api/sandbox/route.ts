export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  getSandboxStatus,
  seedSandbox,
  resetSandbox,
  runSandboxRoundTrip,
} from '@/lib/services/sandbox';
import { runPostingEngineChecks } from '@/lib/services/posting-verify';
import { requirePermission } from '@/lib/rbac/require-permission';
import { requireAuth } from '@/lib/api-handler';
import { sandboxAllowed, SANDBOX_REFUSED_MESSAGE } from '@/lib/services/sandbox-guard';

/**
 * SECURITY (HIGH): every sandbox action targets the CALLER'S verified org (never
 * "the first organization row", which in production is the live Merit tenant) and
 * is refused outright unless the deployment explicitly opts in (ALLOW_SANDBOX=1 on
 * a non-production VERCEL_ENV — see lib/services/sandbox-guard.ts). The services
 * re-assert the same gate, so a future caller can't bypass it.
 */

/** GET /api/sandbox — sandbox status for the caller's own org. */
export async function GET() {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;
  const guard = await requirePermission(authRes.userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();
  try {
    const status = await getSandboxStatus(supabase, guard.orgId);
    return NextResponse.json({ ok: true, enabled: sandboxAllowed(), status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Status failed' }, { status: 500 });
  }
}

/**
 * POST /api/sandbox { action: 'seed' | 'reset' | 'verify' | 'verify-posting' }
 *  - seed:   idempotent seed/repair (COA via real path + entities + master data + jobs)
 *  - reset:  clear transactional + master data, then re-seed
 *  - verify: run the four-path cross-module round-trip and report pass/fail
 */
export async function POST(request: Request) {
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return authRes;

  let action: string | undefined;
  let resetFirst = false;
  try {
    const body = await request.json();
    action = body?.action;
    resetFirst = body?.resetFirst === true;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!action || !['seed', 'reset', 'verify', 'verify-posting'].includes(action)) {
    return NextResponse.json({ error: "action must be one of: 'seed', 'reset', 'verify', 'verify-posting'" }, { status: 422 });
  }

  // Environment gate FIRST: in production nothing below may run, for anyone.
  if (!sandboxAllowed()) {
    return NextResponse.json({ error: SANDBOX_REFUSED_MESSAGE, code: 'SANDBOX_DISABLED' }, { status: 403 });
  }

  // Authorize — seed/reset/verify write (and reset CLEARS) the tenant's
  // transactional and master data through the ADMIN client.
  const guard = await requirePermission(authRes.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId; // the caller's verified tenant — the ONLY org touched

  const supabase = createAdminSupabase();
  try {
    if (action === 'seed') {
      const result = await seedSandbox(supabase, { orgId });
      return NextResponse.json({ ok: true, action, ...result });
    }
    if (action === 'reset') {
      const result = await resetSandbox(supabase, orgId);
      return NextResponse.json({ ok: true, action, ...result });
    }
    if (action === 'verify-posting') {
      // Ensure COA + entities + periods exist, then exercise the deterministic
      // posting engine + settlement lifecycle and assert the GATE 2 criteria.
      await seedSandbox(supabase, { orgId });
      const result = await runPostingEngineChecks(supabase, orgId);
      return NextResponse.json({ ok: true, action, ...result }, { status: result.allPassed ? 200 : 207 });
    }
    // verify
    if (resetFirst) {
      await resetSandbox(supabase, orgId);
    }
    const roundTrip = await runSandboxRoundTrip(supabase, orgId);
    const fresh = await getSandboxStatus(supabase, orgId);
    return NextResponse.json({ ok: true, action, resetFirst, roundTrip, status: fresh });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : `${action} failed` }, { status: 500 });
  }
}
