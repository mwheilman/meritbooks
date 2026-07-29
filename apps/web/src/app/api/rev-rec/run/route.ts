export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { recognizeRun } from '@/lib/services/rev-rec';

function asOfFrom(url: string): string {
  const v = new URL(url).searchParams.get('as_of');
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // default: last day of the prior month (typical month-end recognition)
  const d = new Date();
  const lastOfPrevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return lastOfPrevMonth.toISOString().slice(0, 10);
}

/** GET /api/rev-rec/run?as_of&location_id — preview what would be recognized (no posting). */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId: id, userId } = ctx;
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const asOf = asOfFrom(request.url);
  const locationId = new URL(request.url).searchParams.get('location_id');
  try {
    const result = await recognizeRun(supabase, id, { locationId, asOf, runBy: userId, preview: true });
    return NextResponse.json({ ok: true, preview: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Preview failed' }, { status: 500 });
  }
}

/** POST /api/rev-rec/run { as_of?, location_id? } — recognize and post. */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId: id, userId } = ctx;
  if (!id) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { as_of?: string; location_id?: string | null } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const asOf = body.as_of && /^\d{4}-\d{2}-\d{2}$/.test(body.as_of)
    ? body.as_of
    : asOfFrom(request.url);

  try {
    const result = await recognizeRun(supabase, id, { locationId: body.location_id ?? null, asOf, runBy: userId, preview: false });
    return NextResponse.json({ ok: true, preview: false, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Recognition failed' }, { status: 500 });
  }
}
