export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { convertEstimateToInvoice } from '@/lib/estimates/convert-estimate';

/**
 * POST /api/estimates/[id]/convert — convert an ACCEPTED (or DRAFT / SENT)
 * estimate into a REAL invoice by CALLING the shared invoice-create path. The
 * estimate is stamped CONVERTED + linked to the invoice in the same logical op,
 * and a conditional DB claim makes a second conversion impossible. Gated on
 * invoices:create, the same permission invoice creation requires.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();
  const outcome = await convertEstimateToInvoice(supabase, {
    orgId,
    actor: userId,
    estimateId: params.id,
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  return NextResponse.json(
    {
      invoice_id: outcome.invoiceId,
      invoice_number: outcome.invoiceNumber,
      total_cents: outcome.totalCents,
    },
    { status: 201 },
  );
}
