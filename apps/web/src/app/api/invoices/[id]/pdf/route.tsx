export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/invoices/[id]/pdf — branded PDF for the invoice (FPB §3).
 * Used by the drawer "Download PDF" / "Print" and as the attachment on send.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const doc = await loadInvoiceDocById(supabase, orgId, params.id);
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const buffer = await renderToBuffer(<InvoicePdf doc={doc} />);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${doc.invoice_number}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
