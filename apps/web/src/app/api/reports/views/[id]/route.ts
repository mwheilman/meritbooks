export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * A single saved report view — rename (+ optionally re-capture its config) or delete.
 * RLS-scoped: the row is only reachable inside the caller's org (public.report_views
 * org_isolation policy), so no explicit org filter is needed beyond the id match.
 */

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '');
}

const VIEW_COLUMNS = 'id, name, report_key, config, created_by, created_at, updated_at';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
});

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
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid update', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.config !== undefined) update.config = parsed.data.config;

  const { data, error } = await ctx.supabase
    .from('report_views')
    .update(update)
    .eq('id', params.id)
    .select(VIEW_COLUMNS)
    .single();

  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json({ error: 'Saved views are not available yet.', code: 'VIEWS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ view: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });

  const { error } = await ctx.supabase.from('report_views').delete().eq('id', params.id);
  if (error) {
    if (isMissingRelation(error)) {
      return NextResponse.json({ error: 'Saved views are not available yet.', code: 'VIEWS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ deleted: true });
}
