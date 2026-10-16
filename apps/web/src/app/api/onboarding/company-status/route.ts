export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import { persistOnboardingProgress } from '@/lib/onboarding/status';

/**
 * POST /api/onboarding/company-status — record a company's EXPLICIT opening choice.
 *
 * Body: { companyId: uuid, opening: 'fresh' | 'none' }
 *   - 'fresh' = the owner explicitly chose "Start fresh with no history" for THIS
 *     company, which makes it live without an opening entry (FPB-onboarding §2.7).
 *   - 'none'  = undo that choice.
 *
 * Refuses 'fresh' when the company already has a POSTED opening entry — a posted
 * opening is the truth and is never overwritten by a start-fresh click (so revisiting
 * the wizard can't silently mark posted balances as skipped).
 *
 * Gated exactly like PATCH /api/onboarding/status: settings_acct:edit + the PREPARER
 * capability; org fail-closed; the company must belong to the caller's org (checked on
 * the RLS-scoped client AND an explicit org_id filter).
 */

const bodySchema = z.object({
  companyId: z.string().uuid(),
  opening: z.enum(['fresh', 'none']),
});

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const { preparerRouteDenied } = await import('@/lib/team/admin-scope-guard');
  const preparerDenied = await preparerRouteDenied(orgId, userId);
  if (preparerDenied) return preparerDenied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { companyId, opening } = parsed.data;

  // The company must be the caller's (RLS + explicit org filter).
  const { data: company, error: coErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name')
    .eq('id', companyId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (coErr) return NextResponse.json({ error: coErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  if (!company) return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });

  if (opening === 'fresh') {
    const { data: posted, error: postedErr } = await supabase
      .from('gl_entries')
      .select('id')
      .eq('org_id', orgId)
      .eq('location_id', companyId)
      .eq('source_module', 'OPENING_BALANCE')
      .eq('status', 'POSTED')
      .limit(1);
    if (postedErr) return NextResponse.json({ error: postedErr.message, code: 'QUERY_ERROR' }, { status: 500 });
    if (posted && posted.length > 0) {
      return NextResponse.json(
        {
          error: 'Opening balances are already posted for this company — it is live. Nothing to skip.',
          code: 'OPENING_ALREADY_POSTED',
        },
        { status: 409 },
      );
    }
  }

  const { statePersisted } = await persistOnboardingProgress(createAdminSupabase(), orgId, {
    companies: {
      [companyId]: { opening, updatedAt: new Date().toISOString(), updatedBy: userId },
    },
  });
  if (!statePersisted) {
    return NextResponse.json(
      { error: 'Could not save that choice right now. Please try again.', code: 'NOT_PERSISTED' },
      { status: 503 },
    );
  }

  await logHumanAction(supabase, userId, orgId, {
    action: opening === 'fresh' ? 'onboarding.company.start_fresh' : 'onboarding.company.start_fresh_undo',
    subjectTable: 'locations',
    subjectId: companyId,
    summary: opening === 'fresh'
      ? `Chose to start ${String(company.name ?? 'company')} fresh with no prior history`
      : `Undid the start-fresh choice for ${String(company.name ?? 'company')}`,
    metadata: { opening },
  }).catch(() => { /* audit is best-effort; the choice itself is persisted */ });

  return NextResponse.json({ ok: true, companyId, opening });
}
