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
import { auth } from '@clerk/nextjs/server';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/invoices/[id]/remind — send a manual collections reminder.
 *
 * The one-click "Send reminder" from the collections worklist. It reuses the
 * exact branded-email + PDF + Pay-Now pipeline as /send, so the customer gets a
 * consistent document, but it:
 *   • records REMINDER_SENT (not SENT) — the collections timeline and the
 *     drawer's "Reminder sent" field read off this event;
 *   • never flips DRAFT→SENT (a reminder is for something already issued);
 *   • refuses to chase a paid / voided invoice (nothing is owed).
 *
 * This is the MANUAL rung. The automated, tiered dunning ladder (3 days before
 * due → due → +7 → +14 → +30, with tone escalation and quiet hours) is a later
 * FPB wave and needs its own cadence/persistence tables — see NEEDS CENTRAL.
 *
 * Ordering mirrors /send exactly: the event is written ONLY after the provider
 * confirms acceptance with a message id. A failed send records nothing and
 * returns the real reason, so an invoice never claims a reminder it didn't send.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
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

  // Optional tier label from the caller (e.g. 'MANUAL', 'FIRST_NOTICE'); default
  // MANUAL. Kept in the event meta so a future dunning ladder can read history.
  let tier = 'MANUAL';
  try {
    const body = await req.json();
    if (body && typeof body.tier === 'string' && body.tier.length <= 40) tier = body.tier;
  } catch {
    /* no body is fine — this is a one-click action */
  }

  // Take the tenant from the invoice row, not from "organizations limit 1".
  const { data: row } = await supabase
    .from('invoices')
    .select('org_id, status, balance_cents')
    .eq('id', params.id)
    .maybeSingle();
  const rec = row as { org_id: string; status: string; balance_cents: number | string } | null;
  const orgId = rec?.org_id;
  if (!orgId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  // Don't chase something that isn't owed.
  if (rec.status === 'PAID' || rec.status === 'VOIDED' || rec.status === 'WRITTEN_OFF' || Number(rec.balance_cents ?? 0) <= 0) {
    return NextResponse.json(
      { error: 'This invoice has no open balance to remind on.', code: 'NOTHING_DUE' },
      { status: 422 },
    );
  }

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

  // Reuse the branded invoice email, then reframe the subject as a reminder so
  // the customer sees it as a nudge, not a duplicate first issuance. The body,
  // PDF, and Pay button are identical to the original send.
  const built = buildInvoiceEmail(doc, payUrl);
  const overdue = new Date(`${doc.due_date}T00:00:00`) < new Date();
  const subject = `${overdue ? 'Payment overdue' : 'Payment reminder'}: Invoice ${doc.invoice_number} from ${doc.entity?.name ?? 'your supplier'}`;
  const pdf = await renderToBuffer(<InvoicePdf doc={doc} />);

  let sent;
  try {
    sent = await provider.send(
      {
        to: [to],
        subject,
        html: built.html,
        text: built.text,
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
    console.error('[invoice remind] provider rejected', doc.invoice_number, detail);
    return NextResponse.json({ error: 'The reminder could not be sent.', code: 'EMAIL_SEND_FAILED', detail }, { status: 502 });
  }

  await recordInvoiceEvent(supabase, {
    orgId,
    invoiceId: doc.id,
    type: 'REMINDER_SENT',
    actor: 'system',
    meta: { to, provider: sent.provider, message_id: sent.id, subject, tier, overdue },
  });

  const clerkUserId = await auth()
    .then((a) => a.userId)
    .catch(() => null);
  if (clerkUserId) {
    await logHumanAction(supabase, clerkUserId, orgId, {
      action: 'invoice.remind',
      subjectTable: 'invoices',
      subjectId: doc.id,
      summary: `Sent payment reminder for invoice ${doc.invoice_number} to ${doc.customer?.name ?? to}`,
    });
  }

  return NextResponse.json({
    sent: true,
    to,
    tier,
    message_id: sent.id,
    provider: sent.provider,
    pay_url: payUrl,
  });
}
