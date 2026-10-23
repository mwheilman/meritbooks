export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadCompanyTemplates } from '@/lib/invoices/templates/resolve';
import { createTemplateSchema } from '@/lib/invoices/templates/schema';
import { createTemplate, templateErrorResponse } from '@/lib/invoices/templates/service';
import { decidePayLink, type ConnectionLite } from '@/lib/invoices/pay-link';
import { SAMPLE_TOKEN } from '@/lib/invoices/sample-doc';

/**
 * GET  /api/invoice-templates?location_id=…  — the design screen's template list for one
 *      company (its own templates + organization-wide ones), with how many customers and
 *      invoices use each, and whether this company can take online payments (so the
 *      preview shows a QR code only when the printed invoice really would).
 * POST /api/invoice-templates                 — create a template (invoices:approve).
 */
const listQuery = z.object({ location_id: z.string().uuid().optional() });

export const GET = apiQueryHandler(listQuery, async (q, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'invoices', 'view', { locationId: q.location_id ?? null });
  if (!guard.ok) return guard.response;

  const locationId = q.location_id ?? null;
  const templates = await loadCompanyTemplates(supabase, orgId, locationId);
  const ids = templates.map((t) => t.id).filter((x): x is string => !!x);

  const [assign, invs, conns, loc] = await Promise.all([
    ids.length
      ? supabase.from('customer_invoice_settings').select('template_id').eq('org_id', orgId).in('template_id', ids)
      : Promise.resolve({ data: [] }),
    ids.length
      ? supabase.from('invoices').select('template_id').eq('org_id', orgId).in('template_id', ids)
      : Promise.resolve({ data: [] }),
    supabase.schema('core').from('provider_connections').select('*').eq('org_id', orgId).eq('capability', 'AR_COLLECTION'),
    locationId
      ? supabase.schema('core').from('locations').select('id, name, payment_methods_allowed').eq('org_id', orgId).eq('id', locationId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const tally = (rows: unknown) => {
    const m = new Map<string, number>();
    for (const r of (rows ?? []) as Array<{ template_id: string | null }>) if (r.template_id) m.set(r.template_id, (m.get(r.template_id) ?? 0) + 1);
    return m;
  };
  const byCustomer = tally(assign.data);
  const byInvoice = tally(invs.data);

  const company = loc.data as { id: string; name: string; payment_methods_allowed: string[] | null } | null;
  const pay = decidePayLink({
    publicToken: SAMPLE_TOKEN,
    status: 'SENT',
    balanceCents: 1,
    locationId,
    methodLevels: { entity: company?.payment_methods_allowed ?? null },
    connections: ((conns.data ?? []) as Record<string, unknown>[]).map((c): ConnectionLite => ({
      capability: String(c.capability ?? ''), provider: String(c.provider ?? ''), status: String(c.status ?? ''),
      environment: String(c.environment ?? 'test'), account_handle: (c.account_handle as string | null) ?? null,
      ...('location_id' in c ? { location_id: (c.location_id as string | null) ?? null } : {}),
    })),
  });

  return NextResponse.json({
    company: company ? { id: company.id, name: company.name } : null,
    templates: templates.map((t) => ({
      ...t,
      scope: t.location_id ? 'COMPANY' : 'ORGANIZATION',
      customers: t.id ? byCustomer.get(t.id) ?? 0 : 0,
      invoices: t.id ? byInvoice.get(t.id) ?? 0 : 0,
    })),
    online: { payable: pay.payable, mode: pay.mode, code: pay.code, reason: pay.reason, methods: pay.methods },
  });
});

export const POST = apiHandler(createTemplateSchema, async (body, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'invoices', 'approve', { locationId: body.location_id });
  if (!guard.ok) return guard.response;
  try {
    const t = await createTemplate({ caller: supabase, orgId, userId }, createTemplateSchema.parse(body));
    return NextResponse.json({ template: t }, { status: 201 });
  } catch (e) {
    const r = templateErrorResponse(e);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
});
