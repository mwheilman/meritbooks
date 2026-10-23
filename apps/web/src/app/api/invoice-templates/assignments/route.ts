export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { setCustomerInvoiceSettings, templateErrorResponse } from '@/lib/invoices/templates/service';
import { isEmail, MAX_CC, parseEmailList } from '@/lib/invoices/recipients';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { logHumanAction } from '@/lib/trust/action-log';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * GET /api/invoice-templates/assignments?search=&page=  — customers with their assigned
 *     invoice template and default CC list (paged, 50 per page, debounced search).
 * PUT /api/invoice-templates/assignments                — set one customer's template
 *     (null = use the company default) and default CC list. invoices:create for the
 *     template; CHANGING the default CC list (who silently receives every future invoice
 *     and reminder for this customer) needs invoices:approve. The customer is read through
 *     the caller's RLS client and its company must be in the caller's client scope. CC
 *     changes are action-logged with the before / after lists.
 */
const listQuery = z.object({
  search: z.string().max(100).optional(),
  page: z.string().regex(/^\d+$/).optional(),
});
const PER_PAGE = 50;

export const GET = apiQueryHandler(listQuery, async (q, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'invoices', 'view');
  if (!guard.ok) return guard.response;

  const page = Math.max(1, Number(q.page ?? '1'));
  const from = (page - 1) * PER_PAGE;
  let query = supabase.schema('core').from('customers')
    .select('id, name, display_name, email', { count: 'exact' })
    .eq('org_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .range(from, from + PER_PAGE - 1);
  const term = q.search?.trim().replace(/[%,()]/g, ' ');
  if (term) query = query.or(`name.ilike.%${term}%,display_name.ilike.%${term}%,email.ilike.%${term}%`);
  const { data: custs, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (custs ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null }>;
  const ids = rows.map((r) => r.id);
  const { data: settings } = ids.length
    ? await supabase.from('customer_invoice_settings').select('customer_id, template_id, cc_emails').eq('org_id', orgId).in('customer_id', ids)
    : { data: [] };
  const byCustomer = new Map(((settings ?? []) as Array<{ customer_id: string; template_id: string | null; cc_emails: string[] | null }>)
    .map((s) => [s.customer_id, s]));

  return NextResponse.json({
    customers: rows.map((r) => ({
      id: r.id,
      name: r.display_name || r.name,
      email: r.email,
      templateId: byCustomer.get(r.id)?.template_id ?? null,
      ccEmails: byCustomer.get(r.id)?.cc_emails ?? [],
    })),
    pagination: { page, per_page: PER_PAGE, total: count ?? 0, total_pages: Math.max(1, Math.ceil((count ?? 0) / PER_PAGE)) },
  });
});

const putSchema = z.object({
  customer_id: z.string().uuid(),
  template_id: z.string().uuid().nullable(),
  cc_emails: z.union([z.array(z.string().max(254)), z.string().max(3000)]).default([]),
});

export const PUT = apiHandler(putSchema, async (body, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const cc = Array.from(new Map(parseEmailList(body.cc_emails).map((e) => [e.toLowerCase(), e] as const)).values());
  const bad = cc.filter((e) => !isEmail(e));
  if (bad.length) return NextResponse.json({ error: `Not a valid email address: ${bad.join(', ')}`, code: 'INVALID_EMAIL' }, { status: 422 });
  if (cc.length > MAX_CC) return NextResponse.json({ error: `Copy at most ${MAX_CC} people.`, code: 'TOO_MANY_CC' }, { status: 422 });

  // The customer, through the caller's RLS client (org + client scope proven by the DB).
  const { data: cust } = await supabase.schema('core').from('customers')
    .select('id, name, display_name, location_id').eq('org_id', orgId).eq('id', body.customer_id).maybeSingle();
  const customer = cust as { id: string; name: string; display_name: string | null; location_id: string | null } | null;
  if (!customer) return NextResponse.json({ error: 'Customer not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data: cur } = await supabase.from('customer_invoice_settings')
    .select('cc_emails').eq('org_id', orgId).eq('customer_id', customer.id).maybeSingle();
  const before = ((cur as { cc_emails: string[] | null } | null)?.cc_emails ?? []);
  const norm = (list: string[]) => list.map((e) => e.toLowerCase()).sort().join(',');
  const ccChanged = norm(before) !== norm(cc);

  const guard = await requirePermission(userId, 'invoices', ccChanged ? 'approve' : 'create', { locationId: customer.location_id });
  if (!guard.ok) return guard.response;

  try {
    // The customer's company must be inside the caller's client scope (the write is service-role).
    await assertWriteScope(supabase, orgId, [customer.location_id]);
    const saved = await setCustomerInvoiceSettings({ caller: supabase, orgId, userId }, customer.id, {
      template_id: body.template_id, cc_emails: cc,
    });
    if (ccChanged) {
      await logHumanAction(createAdminSupabase(), userId, orgId, {
        action: 'invoice.customer_cc.change',
        subjectTable: 'customer_invoice_settings',
        subjectId: customer.id,
        summary: `Changed default invoice CC for ${customer.display_name || customer.name}: ${before.length ? before.join(', ') : '(none)'} → ${cc.length ? cc.join(', ') : '(none)'}`.slice(0, 1000),
        locationId: customer.location_id,
      });
    }
    return NextResponse.json({ ok: true, ...saved });
  } catch (e) {
    const r = templateErrorResponse(e);
    if (r) return NextResponse.json(r.body, { status: r.status });
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN_SCOPE' }, { status: 403 });
    throw e;
  }
});
