export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  loadOnboardingStatus,
  persistOnboardingProgress,
  ONBOARDING_STEPS,
  type OnboardingStepKey,
} from '@/lib/onboarding/status';

/**
 * GET /api/onboarding/status — first-run detection + resume point.
 *   Returns { firstRun, complete, currentStep, counts, hasOpeningEntry, ... }.
 *   Read by the root router (to route a first-run tenant into the wizard) and by
 *   the wizard itself (to resume the saved step). RLS-scoped counts; org flags via
 *   the admin client (onboarding_state / setup_complete are service-role-write).
 *
 * PATCH /api/onboarding/status — persist wizard progress.
 *   Body: { currentStep?, complete? }. Gated on settings_acct:edit (a company_admin
 *   action). Degrade-safe: always records completion on setup_complete; records the
 *   rich step flag when the onboarding_state column exists.
 */

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    // No resolvable tenant → treat as not-first-run (fail safe: never trap a user
    // with an unresolved org in the wizard; the root router falls back to dashboard).
    return NextResponse.json({ firstRun: false, complete: true, orgResolved: false });
  }

  try {
    const status = await loadOnboardingStatus(supabase, createAdminSupabase(), orgId);
    return NextResponse.json({ ...status, orgResolved: true });
  } catch (e) {
    // Status must never hard-fail the app shell — degrade to "not first run".
    console.error('[onboarding/status] load error:', e instanceof Error ? e.message : e);
    return NextResponse.json({ firstRun: false, complete: true, orgResolved: true, degraded: true });
  }
}

interface PatchBody {
  currentStep?: string;
  complete?: boolean;
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Persisting onboarding progress is an accounting-settings action.
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  // Running onboarding is a PREPARER responsibility (defense in depth for the page
  // guard). A MANAGEMENT-only admin is denied; fail-open on any absence/error so no
  // one is locked out before the admin_scope migration lands.
  const { preparerRouteDenied } = await import('@/lib/team/admin-scope-guard');
  const preparerDenied = await preparerRouteDenied(orgId, userId);
  if (preparerDenied) return preparerDenied;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const patch: { currentStep?: OnboardingStepKey; complete?: boolean } = {};
  if (typeof body.currentStep === 'string') {
    if (!(ONBOARDING_STEPS as string[]).includes(body.currentStep)) {
      return NextResponse.json({ error: `Unknown step "${body.currentStep}"` }, { status: 422 });
    }
    patch.currentStep = body.currentStep as OnboardingStepKey;
  }
  if (typeof body.complete === 'boolean') patch.complete = body.complete;

  if (patch.currentStep === undefined && patch.complete === undefined) {
    return NextResponse.json({ error: 'Provide currentStep and/or complete' }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const { statePersisted } = await persistOnboardingProgress(admin, orgId, patch);

  return NextResponse.json({ ok: true, statePersisted });
}
