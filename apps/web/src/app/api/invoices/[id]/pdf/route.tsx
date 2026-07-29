export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/invoices/[id]/pdf — branded PDF for the invoice (FPB §3).
 * Used by the drawer "Download PDF" / "Print" and as the attachment on send.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const doc = await loadInvoiceDocById(supabase, orgId, params.id);
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const buffer = await renderToBuffer(<InvoicePdf doc={doc} />);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${doc.invoice_number}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
