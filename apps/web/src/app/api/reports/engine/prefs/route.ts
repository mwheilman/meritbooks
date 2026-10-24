export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { prefsBodySchema } from '@/lib/reports/engine/schema';
import { listPrefs, setFavorite } from '@/lib/reports/engine/prefs';
import { validationResponse } from '@/lib/reports/engine/http';

/** GET — the caller's favourites + recently run reports. POST { reportKey, favorite } — toggle a favourite. */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  try {
    return NextResponse.json({ data: await listPrefs(ctx.supabase, ctx.userId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/prefs' });
  if (!guard.ok) return guard.response;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = prefsBodySchema.safeParse(raw);
  if (!parsed.success) return validationResponse(parsed.error);
  try {
    await setFavorite(orgId, userId, parsed.data.reportKey, parsed.data.favorite);
    return NextResponse.json({ data: { ok: true } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}
