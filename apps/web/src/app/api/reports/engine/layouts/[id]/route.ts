export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { layoutBodySchema } from '@/lib/reports/engine/schema';
import { archiveLayout, saveLayout, LayoutValidationError } from '@/lib/reports/engine/layouts-store';
import { requireFinanceWriter, validationResponse } from '@/lib/reports/engine/http';
import type { LayoutRowDef } from '@/lib/reports/engine/types';

const idSchema = z.string().uuid();

/**
 * PATCH — replace a layout (validated). DELETE — archive it (saved views keep working until
 * re-pointed). Finance only (close_mgmt:manage or journal_entries:create).
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!idSchema.safeParse(params.id).success) return NextResponse.json({ error: 'Invalid id', code: 'VALIDATION_ERROR' }, { status: 422 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/layouts/[id]' });
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
  // the caller must be able to SEE the layout (RLS read) before the service role writes it
  const { data: visible } = await ctx.supabase.from('report_layouts').select('id').eq('id', params.id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Layout not found', code: 'NOT_FOUND' }, { status: 404 });
  try {
    const saved = await saveLayout(orgId, userId, { ...parsed.data, rows: parsed.data.rows as LayoutRowDef[] }, params.id);
    return NextResponse.json({ data: saved });
  } catch (e) {
    if (e instanceof LayoutValidationError) return NextResponse.json({ error: e.message, code: 'INVALID_LAYOUT', issues: e.issues }, { status: 422 });
    if ((e as { code?: string }).code === '23505') return NextResponse.json({ error: 'A layout with that name already exists.', code: 'DUPLICATE' }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!idSchema.safeParse(params.id).success) return NextResponse.json({ error: 'Invalid id', code: 'VALIDATION_ERROR' }, { status: 422 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/layouts/[id]' });
  if (!guard.ok) return guard.response;
  const finance = await requireFinanceWriter(userId);
  if (finance) return finance;
  const { data: visible } = await ctx.supabase.from('report_layouts').select('id').eq('id', params.id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Layout not found', code: 'NOT_FOUND' }, { status: 404 });
  try {
    await archiveLayout(orgId, userId, params.id);
    return NextResponse.json({ data: { ok: true } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed', code: 'DB_ERROR' }, { status: 500 });
  }
}
