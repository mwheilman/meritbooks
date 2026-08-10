export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadEstimateDocById } from '@/lib/estimates/estimate-doc';
import { EstimatePdf } from '@/lib/estimates/estimate-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/estimates/[id]/pdf — branded estimate/quote PDF. Reuses the same
 * @react-pdf/renderer toolchain the invoice PDF uses (no new dependency). Used by
 * the drawer's "Download PDF" action.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const doc = await loadEstimateDocById(supabase, orgId, params.id);
  if (!doc) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const buffer = await renderToBuffer(<EstimatePdf doc={doc} />);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="estimate-${doc.estimate_number}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
