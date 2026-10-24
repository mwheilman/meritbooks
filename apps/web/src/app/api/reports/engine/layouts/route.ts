export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { layoutBodySchema } from '@/lib/reports/engine/schema';
import { listLayouts, saveLayout, LayoutValidationError } from '@/lib/reports/engine/layouts-store';
import { requireFinanceWriter, validationResponse } from '@/lib/reports/engine/http';
import type { LayoutRowDef } from '@/lib/reports/engine/types';

/**
 * GET  /api/reports/engine/layouts — the tenant's custom statement layouts (row designer).
 * POST /api/reports/engine/layouts — create one { name, statement: PNL|BS, rows }. Validated
 * (ids, references, cycles) before save. GET: reports:view. POST: finance only
 * (close_mgmt:manage or journal_entries:create — a layout changes what every reader sees).
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/reports/engine/layouts' });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ data: await listLayouts(ctx.supabase) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/layouts' });
  if (!guard.ok) return guard.response;
  const finance = await requireFinanceWriter(userId);
  if (finance) return finance;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = layoutBodySchema.safeParse(raw);
  if (!parsed.success) return validationResponse(parsed.error);
  try {
    const saved = await saveLayout(orgId, userId, { ...parsed.data, rows: parsed.data.rows as LayoutRowDef[] });
    return NextResponse.json({ data: saved }, { status: 201 });
  } catch (e) {
    if (e instanceof LayoutValidationError) return NextResponse.json({ error: e.message, code: 'INVALID_LAYOUT', issues: e.issues }, { status: 422 });
    if ((e as { code?: string }).code === '23505') return NextResponse.json({ error: 'A layout with that name already exists.', code: 'DUPLICATE' }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : (e as { message?: string }).message ?? 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}
