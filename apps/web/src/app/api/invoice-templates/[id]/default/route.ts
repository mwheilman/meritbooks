export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { setDefaultTemplate, templateErrorResponse } from '@/lib/invoices/templates/service';

/**
 * POST /api/invoice-templates/[id]/default — make this the default template for its
 * company (or for the organization, when it is organization-wide). invoices:approve.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(null, async (_b, ctx) => {
    const { supabase, orgId, userId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const { data } = await supabase.from('invoice_templates').select('location_id').eq('org_id', orgId).eq('id', params.id).maybeSingle();
    if (!data) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    const guard = await requirePermission(userId, 'invoices', 'approve', { locationId: (data as { location_id: string | null }).location_id });
    if (!guard.ok) return guard.response;
    try {
      const t = await setDefaultTemplate({ caller: supabase, orgId, userId }, params.id);
      return NextResponse.json({ template: t });
    } catch (e) {
      const r = templateErrorResponse(e);
      if (r) return NextResponse.json(r.body, { status: r.status });
      throw e;
    }
  })(req);
}
