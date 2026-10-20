export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { dualRunPostSchema, type DualRunPostInput } from '@/lib/validations/access-dual-run';
import {
  authorizeAccessAdmin,
  cancelEnforcementModeChange,
  confirmEnforcementModeChange,
  explainDisagreements,
  loadDualRunStatus,
  requestEnforcementModeChange,
  type ModeChangeOutcome,
} from '@/lib/rbac/dual-run';
import { dbErrorResponse, resolveGovActor } from '@/lib/access-governance/server';
import { requestClientIp } from '@/lib/auth/client-ip';
import { invalidateEnforcementModeCache } from '@/lib/rbac/authorize';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * R-11 dual-run admin (05-RBAC-SPEC §5.7). Tenant admins only.
 *
 * GET  → the tenant's enforcement mode, the dual-run window, disagreement groups by
 *        capability / route over the window (or the last 7 days), and whether the
 *        tenant may flip to v2 (7 full days in dual AND 0 unexplained disagreements).
 * POST { op: 'set_mode', mode, confirmation, reason }   — switch mode (v2 needs the
 *        typed confirmation; the DB re-checks eligibility and refuses otherwise). A
 *        DOWNGRADE from v2 waits for a SECOND tenant admin (mig 170) unless the tenant has
 *        only one admin, in which case it applies with the logged reason.
 *      { op: 'confirm_mode' | 'cancel_mode', requestId } — the second admin confirms (never
 *        the requester, H1) or an admin cancels a pending downgrade.
 *      { op: 'explain', capability, action, route, note } — record why a disagreement
 *        group is expected, which clears it from the flip blockers.
 * Every write is recorded to core.action_log.
 */

const forbidden = () => NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });

export const GET = apiQueryHandler(null, async (_params, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  if (!(await authorizeAccessAdmin({ userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase }))) return forbidden();

  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  const status = await loadDualRunStatus(admin, ctx.orgId, new Date(), actor instanceof NextResponse ? null : actor.userId);
  return NextResponse.json({ data: status });
});

export const POST = apiHandler<DualRunPostInput>(dualRunPostSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const orgId = ctx.orgId;
  if (!(await authorizeAccessAdmin({ userId: ctx.userId, orgId, supabase: ctx.supabase }))) return forbidden();
  const admin = createAdminSupabase();

  if (body.op === 'explain') {
    let updated: number;
    try {
      updated = await explainDisagreements(admin, orgId, body, body.note, ctx.userId);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not record the explanation', code: 'EXPLAIN_FAILED' }, { status: 409 });
    }
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: 'access.dualrun.explain',
      subjectTable: 'access_dualrun_log',
      subjectId: `${body.capability}:${body.action}@${body.route}`,
      summary: `Explained ${updated} access dual-run disagreement${updated === 1 ? '' : 's'} on ${body.capability}:${body.action} (${body.route})`,
      metadata: { capability: body.capability, action: body.action, route: body.route, note: body.note, rows: updated },
    });
    return NextResponse.json({ data: { explained: updated, status: await loadDualRunStatus(admin, orgId) } });
  }

  // Mode changes go through the mig-170 definer: it re-checks the seat, applies or parks a
  // downgrade for a second admin, and writes core.access_change_log.
  const actor = await resolveGovActor(ctx.userId, orgId, admin);
  if (actor instanceof NextResponse) return actor;
  const ip = requestClientIp();

  if (body.op === 'confirm_mode' || body.op === 'cancel_mode') {
    try {
      if (body.op === 'cancel_mode') {
        await cancelEnforcementModeChange(admin, body.requestId, actor.userId);
      } else {
        const outcome = await confirmEnforcementModeChange(admin, body.requestId, actor.userId, ip);
        invalidateEnforcementModeCache(orgId);
        await logHumanAction(ctx.supabase, ctx.userId, orgId, {
          action: 'access.enforcement_mode.confirm',
          subjectTable: 'organizations',
          subjectId: orgId,
          summary: `Confirmed the access enforcement change to ${outcome.mode} (request ${body.requestId})`,
          metadata: { requestId: body.requestId, outcome },
        });
      }
    } catch (e) {
      return dbErrorResponse(e as { code?: string; message?: string });
    }
    return NextResponse.json({ data: { status: await loadDualRunStatus(admin, orgId, new Date(), actor.userId) } });
  }

  // Remaining variant is set_mode (explicit narrow — TS loses the discriminant across the awaits above).
  if (body.op !== 'set_mode') {
    return NextResponse.json({ error: 'Unknown operation', code: 'BAD_OP' }, { status: 400 });
  }
  let outcome: ModeChangeOutcome;
  try {
    outcome = await requestEnforcementModeChange(admin, orgId, body.mode, actor.userId, body.reason, ip);
  } catch (e) {
    // core.set_access_enforcement_mode refuses v2 before 7 days / with open disagreements.
    const err = e as { code?: string; message?: string };
    if (err.code === '42501') return dbErrorResponse(err);
    return NextResponse.json({ error: err.message ?? 'Mode change refused', code: 'NOT_ELIGIBLE' }, { status: 409 });
  }
  if (outcome.status === 'applied') invalidateEnforcementModeCache(orgId);
  await logHumanAction(ctx.supabase, ctx.userId, orgId, {
    action: outcome.status === 'pending' ? 'access.enforcement_mode.request' : 'access.enforcement_mode.set',
    subjectTable: 'organizations',
    subjectId: orgId,
    summary: outcome.status === 'pending'
      ? `Asked to change access enforcement from ${outcome.mode} to ${outcome.requestedMode} — waiting for a second tenant admin: ${body.reason}`
      : outcome.status === 'applied'
        ? `Access enforcement changed from ${outcome.previousMode} to ${outcome.mode}${outcome.singleAdmin ? ' (only tenant admin)' : ''}: ${body.reason}`
        : `Access enforcement already ${outcome.mode}`,
    metadata: { outcome, reason: body.reason },
  });
  return NextResponse.json({
    // `outcome.status` is applied | pending | unchanged; `status` is the refreshed panel.
    data: { mode: outcome.mode, outcome, status: await loadDualRunStatus(admin, orgId, new Date(), actor.userId) },
  });
});
