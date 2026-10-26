export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { updatePackSchema, nextOccurrence, type Cadence } from '@/lib/reports/compiler/packs';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { assertPackWriteScope } from '@/lib/reports/compiler/pack-scope';
import { parsePackItems } from '@/lib/fpna/workspace/pack-items';

/**
 * A single saved report pack — update (rename / schedule) or delete. RLS-scoped.
 *
 * THE HUMAN GATE (canon: no new email auto-sends without the user configuring it):
 * a pack only becomes a live recurring email when the user EXPLICITLY sets
 * schedule_active = true AND a cadence (MONTHLY/QUARTERLY) AND at least one
 * recipient. Any of those missing → the schedule is forced OFF and next_run_date
 * is cleared, so nothing is ever delivered by default.
 *
 * WRITES (security review H3): reports:export; the row is read through RLS (org + 163's client
 * scope: a pack is visible only when every company it names is), its companies (location_ids ∪
 * every dashboard's) are re-checked against the caller's scope, then the service role writes with
 * the org pinned — report_packs is SELECT-only for members (191 §2b).
 */

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '');
}

const PACK_COLUMNS =
  'id, name, entity_label, location_ids, specs, schedule_cadence, recipients, schedule_active, last_run_at, last_run_status, next_run_date, created_at, updated_at';

interface PackRow {
  schedule_cadence: Cadence;
  recipients: string[] | null;
  schedule_active: boolean;
  location_ids: unknown;
  fpna_items?: unknown;
}

/** Read the pack through RLS and check its companies against the caller's scope. */
async function loadWritablePack(ctx: { userId: string; orgId: string; supabase: SupabaseClient }, id: string): Promise<PackRow | NextResponse> {
  const { data: current, error: readErr } = await ctx.supabase
    .from('report_packs')
    .select('schedule_cadence, recipients, schedule_active, location_ids, fpna_items')
    .eq('id', id)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (readErr) {
    if (isMissingRelation(readErr)) {
      return NextResponse.json({ error: 'Saved report packs are not available yet.', code: 'PACKS_UNAVAILABLE' }, { status: 503 });
    }
    console.error('[report-packs] read failed:', readErr.message);
    return NextResponse.json({ error: 'Could not load the pack.', code: 'DB_ERROR' }, { status: 500 });
  }
  if (!current) return NextResponse.json({ error: 'Pack not found', code: 'NOT_FOUND' }, { status: 404 });
  const row = current as PackRow;
  try {
    await assertPackWriteScope(ctx.supabase, ctx.orgId, row.location_ids, parsePackItems(row.fpna_items));
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }
  return row;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const parsed = updatePackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid update', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/reports/packs/[id]' });
  if (!guard.ok) return guard.response;
  // Read the current row (RLS + client scope) to merge schedule fields; its companies are re-checked.
  const loaded = await loadWritablePack({ userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase }, params.id);
  if (loaded instanceof NextResponse) return loaded;
  const cur = loaded;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) update.name = parsed.data.name;

  const scheduleTouched =
    parsed.data.cadence !== undefined ||
    parsed.data.recipients !== undefined ||
    parsed.data.schedule_active !== undefined;

  if (scheduleTouched) {
    const cadence: Cadence = parsed.data.cadence ?? cur.schedule_cadence ?? 'NONE';
    const recipients: string[] = parsed.data.recipients ?? cur.recipients ?? [];
    const wantActive = parsed.data.schedule_active ?? cur.schedule_active ?? false;

    // The gate: a live schedule REQUIRES a real cadence and at least one recipient.
    const effectiveActive = wantActive && cadence !== 'NONE' && recipients.length > 0;

    if (wantActive && !effectiveActive) {
      return NextResponse.json(
        {
          error: 'To schedule delivery, choose a monthly or quarterly cadence and add at least one recipient email.',
          code: 'SCHEDULE_INCOMPLETE',
        },
        { status: 422 },
      );
    }

    update.schedule_cadence = cadence;
    update.recipients = recipients;
    update.schedule_active = effectiveActive;
    update.next_run_date = effectiveActive
      ? nextOccurrence(cadence, new Date().toISOString().slice(0, 10))
      : null;
  }

  const { data, error } = await serviceWriter()
    .from('report_packs')
    .update(update)
    .eq('id', params.id)
    .eq('org_id', ctx.orgId)
    .select(PACK_COLUMNS)
    .single();

  if (error) {
    console.error('[report-packs] update failed:', error.message);
    return NextResponse.json({ error: 'Could not update the pack.', code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ pack: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/reports/packs/[id]' });
  if (!guard.ok) return guard.response;
  const loaded = await loadWritablePack({ userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase }, params.id);
  if (loaded instanceof NextResponse) return loaded;

  const { error } = await serviceWriter().from('report_packs').delete().eq('id', params.id).eq('org_id', ctx.orgId);
  if (error) {
    console.error('[report-packs] delete failed:', error.message);
    return NextResponse.json({ error: 'Could not delete the pack.', code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
