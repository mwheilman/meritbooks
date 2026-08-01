/**
 * Shared invoice-email core.
 *
 * Renders the branded PDF, builds the branded email with the `/pay/[token]` link,
 * hands it to the resolved provider, and — ONLY after the provider confirms with a
 * message id — records the SENT event and flips DRAFT → SENT. Recording SENT first
 * (or best-effort) would produce an invoice that claims to have shipped and never
 * left the building, the silent-success failure this codebase has been bitten by.
 *
 * Both `POST /api/invoices/[id]/send` (interactive) and the recurring-invoice
 * generator's auto-send call this, so a scheduled send is byte-identical to a
 * hand-clicked one. Human-action audit logging stays in the route (it needs the
 * Clerk actor); the generator's SENT events are attributed to 'system'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { buildInvoiceEmail } from '@/lib/invoices/invoice-email';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import { renderToBuffer } from '@react-pdf/renderer';

export interface SendInvoiceResult {
  ok: boolean;
  status: number;
  code?: string;
  error?: string;
  detail?: string;
  to?: string;
  message_id?: string;
  provider?: string;
  pay_url?: string;
}

/**
 * Send invoice `invoiceId` (belonging to `orgId`) to the customer on file.
 * `actor` attributes the SENT event ('system' for scheduled generation).
 * Returns a discriminated result the caller maps to an HTTP response (or ignores,
 * for best-effort auto-send).
 */
export async function sendInvoiceById(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string,
  actor: string | null = 'system',
): Promise<SendInvoiceResult> {
  const provider = resolveEmailProvider();
  if (!provider) {
    return {
      ok: false, status: 503, code: 'EMAIL_NOT_CONFIGURED',
      error: 'Email is not configured.',
      detail: 'Set RESEND_API_KEY and INVOICE_FROM_EMAIL, and verify the sending domain.',
    };
  }

  const from = resolveFromAddress();
  if (!from) {
    return {
      ok: false, status: 503, code: 'EMAIL_FROM_MISSING',
      error: 'No sending address configured.',
      detail: 'Set INVOICE_FROM_EMAIL to an address on a domain verified with the provider.',
    };
  }

  const doc = await loadInvoiceDocById(supabase, orgId, invoiceId);
  if (!doc) return { ok: false, status: 404, error: 'Invoice not found' };

  const to = doc.customer?.email;
  if (!to) {
    return {
      ok: false, status: 422, code: 'CUSTOMER_EMAIL_MISSING',
      error: `${doc.customer?.name ?? 'This customer'} has no email address on file.`,
    };
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
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
          { filename: `invoice-${doc.invoice_number}.pdf`, content: new Uint8Array(pdf), contentType: 'application/pdf' },
        ],
      },
      from,
    );
  } catch (e) {
    const detail = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Unknown error';
    console.error('[invoice send] provider rejected', doc.invoice_number, detail);
    // Nothing recorded — the invoice must not claim to have been sent.
    return { ok: false, status: 502, code: 'EMAIL_SEND_FAILED', error: 'The email could not be sent.', detail };
  }

  // Confirmed accepted, with a provider message id. Now it is true.
  await recordInvoiceEvent(supabase, {
    orgId, invoiceId: doc.id, type: 'SENT', actor,
    meta: { to, provider: sent.provider, message_id: sent.id, subject },
  });

  if (doc.status === 'DRAFT') {
    await supabase.from('invoices').update({ status: 'SENT' }).eq('id', doc.id);
  }

  return { ok: true, status: 200, to, message_id: sent.id, provider: sent.provider, pay_url: payUrl };
}
