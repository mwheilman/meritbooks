export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocByToken } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/pay/[token]/pdf — the branded invoice PDF, for the customer.
 *
 * The hosted pay page's ↓PDF button previously pointed at
 * /api/invoices/[id]/pdf, which sits behind Clerk. Customers never have a
 * session, so it 404'd for exactly the audience it was built for — the same root
 * cause as the payment-intent bug fixed alongside this.
 *
 * The fix is a tokenized route, NOT widening the middleware matcher to
 * /api/invoices. Two reasons that distinction matters:
 *
 *   1. /api/invoices/[id]/pdf is addressed by raw invoice id. Making it public
 *      would let anyone holding (or guessing) an id pull the document.
 *   2. public_token is the credential the rest of this surface already uses. It
 *      is single-purpose, per-invoice, and revocable by rotating the column.
 *
 * Scope is therefore identical to the page the customer is already looking at:
 * one token, one invoice, nothing else reachable.
 */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const supabase = createAdminSupabase();

  const loaded = await loadInvoiceDocByToken(supabase, params.token);
  if (!loaded) {
    return NextResponse.json({ error: 'This invoice link is no longer valid.' }, { status: 404 });
  }

  const buffer = await renderToBuffer(<InvoicePdf doc={loaded.doc} />);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${loaded.doc.invoice_number}.pdf"`,
      // Customer-facing and token-scoped: never cached by shared proxies.
      'Cache-Control': 'private, no-store',
    },
  });
}
