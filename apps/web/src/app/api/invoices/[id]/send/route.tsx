export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { buildInvoiceEmail } from '@/lib/invoices/invoice-email';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * POST /api/invoices/[id]/send — email the invoice to the customer.
 *
 * The missing half of the invoice loop. Everything upstream — branded PDF,
 * hosted pay page, Stripe rails, GL posting — only pays off once the invoice
 * reaches an inbox with a working Pay button.
 *
 * ORDERING IS DELIBERATE. The SENT event is recorded ONLY after the provider
 * confirms acceptance with a message id. Recording it first, or on a best-effort
 * basis, would produce an invoice that claims to have been sent and never left
 * the building — the same silent-success failure that produced eight defects in
 * this codebase. If the send fails, nothing is recorded and the caller gets the
 * real reason.
 *
 * "Not configured" and "send failed" are returned distinctly. They are different
 * problems with different fixes and should never share a message.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createAdminSupabase();

  const provider = resolveEmailProvider();
  if (!provider) {
    return NextResponse.json(
      {
        error: 'Email is not configured.',
        code: 'EMAIL_NOT_CONFIGURED',
        detail: 'Set RESEND_API_KEY and INVOICE_FROM_EMAIL, and verify the sending domain.',
      },
      { status: 503 },
    );
  }

  const from = resolveFromAddress();
  if (!from) {
    return NextResponse.json(
      {
        error: 'No sending address configured.',
        code: 'EMAIL_FROM_MISSING',
        detail: 'Set INVOICE_FROM_EMAIL to an address on a domain verified with the provider.',
      },
      { status: 503 },
    );
  }

  // Take the tenant from the RECORD, not from `organizations limit 1`. Most of
  // this API resolves the org as "whichever row sorts first", which is correct
  // only while exactly one org exists (see tenant-isolation.test.ts). The
  // invoice already carries its own org_id, so there is no reason to guess here.
  const { data: row } = await supabase
    .from('invoices')
    .select('org_id')
    .eq('id', params.id)
    .maybeSingle();
  const orgId = (row as { org_id: string } | null)?.org_id;
  if (!orgId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const doc = await loadInvoiceDocById(supabase, orgId, params.id);
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const to = doc.customer?.email;
  if (!to) {
    return NextResponse.json(
      {
        error: `${doc.customer?.name ?? 'This customer'} has no email address on file.`,
        code: 'CUSTOMER_EMAIL_MISSING',
      },
      { status: 422 },
    );
  }

  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
  const payUrl = `${base}/pay/${doc.public_token}`;

  const { subject, html, text } = buildInvoiceEmail(doc, payUrl);
  const pdf = await renderToBuffer(<InvoicePdf doc={doc} />);

  let sent;
  try {
    sent = await provider.send(
      {
        to: [to],
        subject,
        html,
        text,
        attachments: [
          {
            filename: `invoice-${doc.invoice_number}.pdf`,
            content: new Uint8Array(pdf),
            contentType: 'application/pdf',
          },
        ],
      },
      from,
    );
  } catch (e) {
    const detail = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Unknown error';
    console.error('[invoice send] provider rejected', doc.invoice_number, detail);
    // Nothing recorded — the invoice must not claim to have been sent.
    return NextResponse.json({ error: 'The email could not be sent.', code: 'EMAIL_SEND_FAILED', detail }, { status: 502 });
  }

  // Confirmed accepted, with a provider message id. Now it is true.
  await recordInvoiceEvent(supabase, {
    orgId,
    invoiceId: doc.id,
    type: 'SENT',
    actor: 'system',
    meta: { to, provider: sent.provider, message_id: sent.id, subject },
  });

  // A draft that has now been sent is no longer a draft.
  if (doc.status === 'DRAFT') {
    await supabase.from('invoices').update({ status: 'SENT' }).eq('id', doc.id);
  }

  return NextResponse.json({
    sent: true,
    to,
    message_id: sent.id,
    provider: sent.provider,
    pay_url: payUrl,
  });
}
