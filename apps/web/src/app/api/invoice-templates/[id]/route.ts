export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { patchTemplateSchema } from '@/lib/invoices/templates/schema';
import { deleteTemplate, templateErrorResponse, updateTemplate } from '@/lib/invoices/templates/service';

/**
 * PATCH  /api/invoice-templates/[id] — save design changes (invoices:approve).
 * DELETE /api/invoice-templates/[id] — delete a non-default template; customers and
 *        invoices that used it fall back to the company default (invoices:approve).
 */
type Params = { params: { id: string } };

const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function locationOf(ctx: { supabase: import('@supabase/supabase-js').SupabaseClient; orgId: string }, id: string) {
  const { data } = await ctx.supabase.from('invoice_templates').select('location_id').eq('org_id', ctx.orgId).eq('id', id).maybeSingle();
  return data ? ((data as { location_id: string | null }).location_id ?? null) : undefined;
}

export async function PATCH(req: Request, { params }: Params) {
  return apiHandler(patchTemplateSchema, async (body, ctx) => {
    const { supabase, orgId, userId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!isId(params.id)) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const loc = await locationOf({ supabase, orgId }, params.id);
    if (loc === undefined) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const guard = await requirePermission(userId, 'invoices', 'approve', { locationId: loc });
    if (!guard.ok) return guard.response;
    try {
      const t = await updateTemplate({ caller: supabase, orgId, userId }, params.id, patchTemplateSchema.parse(body));
      return NextResponse.json({ template: t });
    } catch (e) {
      const r = templateErrorResponse(e);
      if (r) return NextResponse.json(r.body, { status: r.status });
      throw e;
    }
  })(req);
}

export async function DELETE(req: Request, { params }: Params) {
  return apiHandler(null, async (_b, ctx) => {
    const { supabase, orgId, userId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!isId(params.id)) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const loc = await locationOf({ supabase, orgId }, params.id);
    if (loc === undefined) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const guard = await requirePermission(userId, 'invoices', 'approve', { locationId: loc });
    if (!guard.ok) return guard.response;
    try {
      const freed = await deleteTemplate({ caller: supabase, orgId, userId }, params.id);
      return NextResponse.json({ ok: true, ...freed });
    } catch (e) {
      const r = templateErrorResponse(e);
      if (r) return NextResponse.json(r.body, { status: r.status });
      throw e;
    }
  })(req);
}
