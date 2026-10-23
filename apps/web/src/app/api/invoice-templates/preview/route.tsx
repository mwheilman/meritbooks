export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderToBuffer } from '@react-pdf/renderer';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { templateBodySchema } from '@/lib/invoices/templates/schema';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { sampleInvoiceDoc, SAMPLE_TOKEN } from '@/lib/invoices/sample-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { resolveCompanyPayLink } from '@/lib/invoices/pay-link';
import type { InvoiceTemplate } from '@/lib/invoices/templates/types';
import { isTenantLogoUrl, LOGO_URL_ERROR } from '@/lib/invoices/templates/logo-url';

/**
 * POST /api/invoice-templates/preview — render the template being edited as a PDF, live.
 *
 * With `invoice_id` it renders that real invoice (read through the member's RLS client)
 * in the draft design; without it, a clearly-labelled sample invoice for the company. In
 * both cases the pay URL / QR appear only if this company can really take online
 * payments — the preview never shows something the printed invoice won't.
 * Nothing is saved. invoices:view.
 */
const bodySchema = z.object({
  template: templateBodySchema,
  location_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable().optional(),
});

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'invoices', 'view', { locationId: body.location_id });
  if (!guard.ok) return guard.response;

  // apiHandler types the body as the schema INPUT; re-parse for the defaulted output shape.
  const tplBody = templateBodySchema.parse(body.template);
  // The renderer fetches the logo server-side: only this org's own upload is allowed.
  if (tplBody.logo_url && !isTenantLogoUrl(tplBody.logo_url, orgId)) {
    return NextResponse.json({ error: LOGO_URL_ERROR, code: 'LOGO_URL_NOT_ALLOWED' }, { status: 422 });
  }
  const draft = (base: InvoiceTemplate): InvoiceTemplate => ({ ...base, ...tplBody, logo_url: tplBody.logo_url ?? null });

  let doc;
  if (body.invoice_id) {
    const real = await loadInvoiceDocById(supabase, orgId, body.invoice_id);
    if (!real) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    // The draft design wins over the saved template; per-invoice text overrides still apply.
    doc = { ...real, template: draft(real.template) };
  } else {
    const { data: loc } = body.location_id
      ? await supabase.schema('core').from('locations').select('name').eq('org_id', orgId).eq('id', body.location_id).maybeSingle()
      : { data: null };
    const sample = sampleInvoiceDoc({}, {}, (loc as { name: string } | null)?.name ?? 'Your Company');
    const pay = await resolveCompanyPayLink(supabase, orgId, body.location_id ?? null, SAMPLE_TOKEN);
    doc = { ...sample, template: draft(sample.template), pay, customer_message: tplBody.default_message ?? sample.customer_message };
  }

  const buffer = await renderToBuffer(<InvoicePdf doc={doc} />);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="invoice-preview.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
});
