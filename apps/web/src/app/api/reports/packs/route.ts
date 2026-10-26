export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { createPackSchema } from '@/lib/reports/compiler/packs';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { assertPackWriteScope } from '@/lib/reports/compiler/pack-scope';

/**
 * Saved report packs — list + create. RLS-scoped (ctx.supabase); the report_packs
 * table isolates by get_org_id(). DEGRADES SAFE: if the table has not been created
 * yet (migration pending) both verbs report `available: false` so the UI shows the
 * feature as unavailable and ad-hoc compilation still works.
 *
 * Saving a pack NEVER schedules delivery or emails anyone — schedule fields start
 * OFF (cadence NONE, no recipients, inactive). Scheduling is a separate explicit
 * PATCH (see [id]/route.ts).
 *
 * WRITES (security review H3): report_packs is SELECT-only for members (migration 191 §2b). Create
 * = reports:export, then the companies are checked against the caller's org + client scope (an
 * all-companies pack needs all-clients scope), then the service role inserts with the org pinned.
 */

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '');
}

const PACK_COLUMNS =
  'id, name, entity_label, location_ids, specs, schedule_cadence, recipients, schedule_active, last_run_at, last_run_status, next_run_date, created_at, updated_at';

export const GET = apiQueryHandler(null, async (_params, ctx: ApiContext) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/reports/packs' });
  if (!guard.ok) return guard.response;

  const { data, error } = await ctx.supabase
    .from('report_packs')
    .select(PACK_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json({ available: false, packs: [] });
    }
    console.error('[report-packs] list failed:', error.message);
    return NextResponse.json({ error: 'Could not load saved packs.', code: 'DB_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ available: true, packs: data ?? [] });
});

export const POST = apiHandler(createPackSchema, async (body, ctx: ApiContext) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/reports/packs' });
  if (!guard.ok) return guard.response;
  try {
    await assertPackWriteScope(ctx.supabase, ctx.orgId, body.location_ids ?? [], []);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }

  const { data, error } = await serviceWriter()
    .from('report_packs')
    .insert({
      org_id: ctx.orgId,
      name: body.name,
      specs: body.specs,
      entity_label: body.entity_label ?? 'All Companies (Consolidated)',
      location_ids: body.location_ids ?? [],
      schedule_cadence: 'NONE',
      recipients: [],
      schedule_active: false,
      created_by: ctx.userId,
    })
    .select(PACK_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json(
        {
          error: 'Saved report packs are not available yet (database migration pending).',
          code: 'PACKS_UNAVAILABLE',
        },
        { status: 503 },
      );
    }
    console.error('[report-packs] create failed:', error.message);
    return NextResponse.json({ error: 'Could not save the pack.', code: 'DB_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ pack: data }, { status: 201 });
});
