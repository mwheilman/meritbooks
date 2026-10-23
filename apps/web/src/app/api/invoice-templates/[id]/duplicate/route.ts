export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { duplicateTemplate, templateErrorResponse } from '@/lib/invoices/templates/service';

/**
 * POST /api/invoice-templates/[id]/duplicate — copy a template ("Copy of …"), optionally
 * into another company (location_id) or organization-wide (null). invoices:approve.
 */
const bodySchema = z.object({ location_id: z.string().uuid().nullable().optional() }).strict();

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const raw = await req.text();
  const forward = new Request(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw.trim() ? raw : '{}' });
  return apiHandler(bodySchema, async (body, ctx) => {
    const { supabase, orgId, userId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const guard = await requirePermission(userId, 'invoices', 'approve', { locationId: body.location_id ?? null });
    if (!guard.ok) return guard.response;
    try {
      const t = await duplicateTemplate({ caller: supabase, orgId, userId }, params.id, body.location_id);
      return NextResponse.json({ template: t }, { status: 201 });
    } catch (e) {
      const r = templateErrorResponse(e);
      if (r) return NextResponse.json(r.body, { status: r.status });
      throw e;
    }
  })(forward);
}
