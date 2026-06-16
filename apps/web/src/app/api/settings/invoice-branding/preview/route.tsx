export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { InvoicePdf, type InvoiceStyle } from '@/lib/invoices/invoice-pdf';
import type { InvoiceDoc } from '@/lib/invoices/invoice-doc';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/settings/invoice-branding/preview?style=&accent=&logo=&entity=
 * Renders a representative sample invoice in the chosen style so the user sees
 * their display options live while configuring them. Uses canned sample data —
 * no DB read — so it's instant and works before any invoice exists.
 */
export async function GET(request: Request) {
  await auth().catch(() => null);
  const { searchParams } = new URL(request.url);
  const style = (searchParams.get('style') as InvoiceStyle) || 'MODERN';
  const accent = searchParams.get('accent') || '#10b981';
  const logo = searchParams.get('logo');
  const entity = searchParams.get('entity') || 'Your Company';

  const doc: InvoiceDoc = {
    id: 'sample', invoice_number: 'INV-001042', invoice_date: '2026-06-02', due_date: '2026-07-02',
    status: 'SENT', po_number: 'PO-7781', terms: 'NET_30', public_token: 'sample',
    payment_methods_allowed: null, card_surcharge_enabled: null,
    customer_message: 'Thank you for your business. Bank transfer (ACH) is free; pay online from the link on your emailed copy.',
    subtotal_cents: 1250000, discount_cents: 50000, tax_cents: 84000, retainage_cents: 60000,
    total_cents: 1224000, amount_paid_cents: 300000, balance_cents: 924000,
    bill_to: { line1: 'Acme Test Co', line2: '118 Industrial Way', city_state_zip: 'Johnston, IA 50131' }, ship_to: null,
    lines: [
      { line_number: 1, description: 'Kitchen cabinetry — fabrication & install (March)', quantity: 1, unit_price_cents: 850000, amount_cents: 850000, account: { account_number: '4010', name: 'Construction Revenue' } },
      { line_number: 2, description: 'HVAC rough-in', quantity: 1, unit_price_cents: 400000, amount_cents: 400000, account: { account_number: '4020', name: 'HVAC Revenue' } },
    ],
    customer: { name: 'Acme Test Co', email: 'ap@acme.test' },
    entity: { name: entity, short_code: null },
    template: { style, logo_url: logo, accent_color: accent, remit_to: `${entity}\nPO Box 4410\nJohnston, IA 50131`, footer_text: `${entity} · billing@example.com` },
  };

  const buffer = await renderToBuffer(<InvoicePdf doc={doc} style={style} />);
  return new NextResponse(buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="preview.pdf"', 'Cache-Control': 'no-store' },
  });
}
