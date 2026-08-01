export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { loadCustomerStatement, type StatementMode } from '@/lib/invoices/statement';
import { StatementPdf } from '@/lib/invoices/statement-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/customers/[id]/statement — branded AR statement PDF (FPB-invoices §7).
 *
 * RLS-scoped: uses the caller's authed, org-scoped supabase client so a customer
 * from another tenant is simply not found. Query params:
 *   - mode: 'open' (open-item, default) | 'activity' (all invoices in a window)
 *   - as_of: YYYY-MM-DD (aging as-of date; defaults today)
 *   - from / to: YYYY-MM-DD (activity-mode window bounds)
 *   - download: '1' to force a Content-Disposition attachment (default inline).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(req.url);
  const mode: StatementMode = searchParams.get('mode') === 'activity' ? 'activity' : 'open';
  const asOf = normalizeDate(searchParams.get('as_of'));
  const from = normalizeDate(searchParams.get('from'));
  const to = normalizeDate(searchParams.get('to'));

  const doc = await loadCustomerStatement(supabase, orgId, params.id, {
    mode,
    asOf: asOf ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
  });
  if (!doc) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const buffer = await renderToBuffer(<StatementPdf doc={doc} />);
  const slug = doc.customer.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'customer';
  const disposition = searchParams.get('download') === '1' ? 'attachment' : 'inline';

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="statement-${slug}-${doc.asOf}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/** Accept only YYYY-MM-DD; ignore anything malformed so a bad param can't 500. */
function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
