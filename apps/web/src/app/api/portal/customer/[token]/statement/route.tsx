export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePortalToken } from '@/lib/portal/customer/tokens';
import { loadCustomerStatement } from '@/lib/invoices/statement';
import { StatementPdf } from '@/lib/invoices/statement-pdf';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * GET /api/portal/customer/[token]/statement — branded AR statement PDF for the
 * PUBLIC customer portal (no login). This is the token-scoped twin of the
 * authenticated /api/customers/[id]/statement route (which sits behind Clerk and
 * 404s for customers, who never have a session).
 *
 * SECURITY: the token is the credential. resolvePortalToken validates it with the
 * service-role client and yields org_id + customer_id; loadCustomerStatement is
 * then called with EXACTLY that org + customer, so the PDF can only ever contain
 * this one customer's data. Revoked/expired tokens fall through to a clean 404.
 */
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const admin = createAdminSupabase();
  const resolved = await resolvePortalToken(admin, params.token);
  if (!resolved) {
    return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 });
  }

  const doc = await loadCustomerStatement(admin, resolved.orgId, resolved.customerId, { mode: 'open' });
  if (!doc) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const buffer = await renderToBuffer(<StatementPdf doc={doc} />);
  const slug = doc.customer.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'customer';

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="statement-${slug}-${doc.asOf}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
