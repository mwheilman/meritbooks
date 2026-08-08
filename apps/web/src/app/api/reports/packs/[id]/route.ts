export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { updatePackSchema, nextOccurrence, type Cadence } from '@/lib/reports/compiler/packs';

/**
 * A single saved report pack — update (rename / schedule) or delete. RLS-scoped.
 *
 * THE HUMAN GATE (canon: no new email auto-sends without the user configuring it):
 * a pack only becomes a live recurring email when the user EXPLICITLY sets
 * schedule_active = true AND a cadence (MONTHLY/QUARTERLY) AND at least one
 * recipient. Any of those missing → the schedule is forced OFF and next_run_date
 * is cleared, so nothing is ever delivered by default.
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

  // Read the current row (RLS scopes to the caller's org) to merge schedule fields.
  const { data: current, error: readErr } = await ctx.supabase
    .from('report_packs')
    .select('schedule_cadence, recipients, schedule_active')
    .eq('id', params.id)
    .maybeSingle();
  if (readErr) {
    if (isMissingRelation(readErr)) {
      return NextResponse.json({ error: 'Saved report packs are not available yet.', code: 'PACKS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: readErr.message, code: 'DB_ERROR' }, { status: 500 });
  }
  if (!current) return NextResponse.json({ error: 'Pack not found', code: 'NOT_FOUND' }, { status: 404 });
  const cur = current as PackRow;

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

  const { data, error } = await ctx.supabase
    .from('report_packs')
    .update(update)
    .eq('id', params.id)
    .select(PACK_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  return NextResponse.json({ pack: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });

  const { error } = await ctx.supabase.from('report_packs').delete().eq('id', params.id);
  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json({ error: 'Saved report packs are not available yet.', code: 'PACKS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
