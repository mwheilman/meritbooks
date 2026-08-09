export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadRemittanceDoc } from '@/lib/ap/remittance-doc';
import { RemittancePdf } from '@/lib/ap/remittance-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/ap/disbursements/remittance?vendorId=<id> — the remittance-advice PDF
 * for one vendor in the approved pay-run batch (which invoices this payment
 * covers). READ-ONLY: renders a document from the approved batch; no money moves,
 * nothing posts to the GL, no bank is contacted. RLS scopes every read to the org.
 * Bank detail, if any, prints MASKED (last-4) only.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const url = new URL(request.url);
  const vendorId = url.searchParams.get('vendorId');
  if (!vendorId) return NextResponse.json({ error: 'vendorId is required' }, { status: 400 });

  const doc = await loadRemittanceDoc(supabase, orgId, vendorId);
  if (!doc) {
    return NextResponse.json({ error: 'No approved payment for that vendor in the current batch' }, { status: 404 });
  }

  const buffer = await renderToBuffer(<RemittancePdf doc={doc} />);
  const safeVendor = doc.vendorName.replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'vendor';
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="remittance-${safeVendor}-${doc.generatedDate}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
