export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { sendInvoiceById } from '@/lib/invoices/send-invoice';
import { auth } from '@clerk/nextjs/server';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/invoices/[id]/send — email the invoice to the customer.
 *
 * The missing half of the invoice loop. Everything upstream — branded PDF,
 * hosted pay page, Stripe rails, GL posting — only pays off once the invoice
 * reaches an inbox with a working Pay button.
 *
 * The send itself lives in the shared `sendInvoiceById` core (also used by the
 * recurring-invoice auto-send), which records SENT ONLY after the provider
 * confirms with a message id. This route resolves the tenant from the record,
 * delegates, and adds the human-action audit trail.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createAdminSupabase();

  // Take the tenant from the RECORD, not from `organizations limit 1`. The
  // invoice already carries its own org_id, so there is no reason to guess.
  const { data: row } = await supabase
    .from('invoices')
    .select('org_id')
    .eq('id', params.id)
    .maybeSingle();
  const orgId = (row as { org_id: string } | null)?.org_id;
  if (!orgId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const result = await sendInvoiceById(supabase, orgId, params.id, 'system');
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.detail ? { detail: result.detail } : {}) },
      { status: result.status },
    );
  }

  // Human-action audit trail. This route runs on the admin client with no authed
  // context, so resolve the Clerk actor opportunistically — never fail the send.
  const clerkUserId = await auth().then((a) => a.userId).catch(() => null);
  if (clerkUserId) {
    await logHumanAction(supabase, clerkUserId, orgId, {
      action: 'invoice.send',
      subjectTable: 'invoices',
      subjectId: params.id,
      summary: `Sent invoice ${params.id} to ${result.to}`,
    });
  }

  return NextResponse.json({
    sent: true,
    to: result.to,
    message_id: result.message_id,
    provider: result.provider,
    pay_url: result.pay_url,
  });
}
