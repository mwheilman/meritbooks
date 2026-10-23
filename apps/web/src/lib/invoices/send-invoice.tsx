/**
 * Shared invoice-email core.
 *
 * Renders the branded PDF, builds the branded email (Pay button only when the invoice
 * is really payable online), resolves To / Cc / Bcc (recipients.ts), attaches the PDF
 * plus any invoice documents the sender picked (when the template allows attachments),
 * hands it to the resolved provider, and — ONLY after the provider confirms with a
 * message id — records the SENT event and flips DRAFT → SENT. Recording SENT first (or
 * best-effort) would produce an invoice that claims to have shipped and never left the
 * building, the silent-success failure this codebase has been bitten by.
 *
 * Both `POST /api/invoices/[id]/send` (interactive) and the recurring-invoice
 * generator's auto-send call this, so a scheduled send is byte-identical to a
 * hand-clicked one (the generator passes no options: customer email + saved CC list).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { buildInvoiceEmail } from '@/lib/invoices/invoice-email';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveRecipients } from '@/lib/invoices/recipients';
import { serviceWriter, writerFor } from '@/lib/db/scoped-writer';
import { DOCUMENTS_BUCKET } from '@/lib/documents/store';
import { isOrgStoragePath } from '@/lib/documents/schema';
import { resolveEmailProvider, resolveFromAddress, EmailSendError, type EmailAttachment } from '@/lib/email/provider';
import { consumeSendQuota } from '@/lib/email/send-quota';
import { renderToBuffer } from '@react-pdf/renderer';

export interface SendInvoiceResult {
  ok: boolean;
  status: number;
  code?: string;
  error?: string;
  detail?: string;
  to?: string;
  cc?: string[];
  message_id?: string;
  provider?: string;
  pay_url?: string;
  payable?: boolean;
  attachments?: string[];
}

export interface SendInvoiceOptions {
  /** Address for this send (default: the customer's email on file). */
  to?: string | null;
  /** CC list for this send. undefined = the saved invoice + customer CC lists. */
  cc?: string[];
  /** Hidden copy to the sender ("send me a copy"). */
  copyToSelf?: string | null;
  /** Message for this send (replaces the invoice's customer message in the email). */
  message?: string | null;
  /** public.documents ids attached to this invoice to send along with the PDF. */
  attachmentIds?: string[];
  /** Remember this CC list on the invoice for later resends / reminders. */
  saveCcOnInvoice?: boolean;
  /**
   * Meter this send against the member's / org's outbound quota (lib/email/send-quota).
   * Set by interactive sends; the recurring generator's scheduled auto-send leaves it unset.
   */
  quotaUserId?: string | null;
}

/** Total size limit for extra attachments (the provider caps a message at 40 MB). */
const MAX_EXTRA_BYTES = 15 * 1024 * 1024;


async function loadExtraAttachments(
  orgId: string,
  invoiceId: string,
  ids: string[],
): Promise<{ ok: true; files: EmailAttachment[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, files: [] };
  const admin = serviceWriter();
  const { data, error } = await admin
    .from('documents')
    .select('id, org_id, storage_path, file_name, mime_type, size_bytes')
    .eq('org_id', orgId)
    .eq('entity_type', 'invoice')
    .eq('entity_id', invoiceId)
    .in('id', ids);
  if (error) return { ok: false, error: `Could not load the attachments: ${error.message}` };
  const rows = (data ?? []) as Array<{ id: string; org_id: string; storage_path: string; file_name: string; mime_type: string | null; size_bytes: number | null }>;
  if (rows.length !== new Set(ids).size) return { ok: false, error: 'One of the attachments is not on this invoice.' };
  // Belt and braces on the service-role read: the row is this org's AND its object lives in
  // this org's folder. Anything else is refused, never downloaded.
  const foreign = rows.find((r) => r.org_id !== orgId || !isOrgStoragePath(orgId, r.storage_path));
  if (foreign) {
    console.error('[invoice send] refused attachment outside the org folder', foreign.id);
    return { ok: false, error: `${foreign.file_name} cannot be attached. Upload it to this invoice again.` };
  }
  const total = rows.reduce((s, r) => s + Number(r.size_bytes ?? 0), 0);
  if (total > MAX_EXTRA_BYTES) return { ok: false, error: 'Attachments are larger than 15 MB in total. Send fewer files.' };
  const files: EmailAttachment[] = [];
  for (const r of rows) {
    const { data: blob, error: dErr } = await admin.storage.from(DOCUMENTS_BUCKET).download(r.storage_path);
    if (dErr || !blob) return { ok: false, error: `Could not read ${r.file_name}.` };
    files.push({ filename: r.file_name, content: new Uint8Array(await blob.arrayBuffer()), contentType: r.mime_type ?? 'application/octet-stream' });
  }
  return { ok: true, files };
}

/**
 * Send invoice `invoiceId` (belonging to `orgId`). `actor` attributes the SENT event
 * ('system' for scheduled generation). Returns a discriminated result the caller maps
 * to an HTTP response (or ignores, for best-effort auto-send).
 */
export async function sendInvoiceById(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string,
  actor: string | null = 'system',
  opts: SendInvoiceOptions = {},
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
  if (doc.status === 'VOIDED') return { ok: false, status: 409, code: 'INVOICE_VOIDED', error: 'This invoice is voided and cannot be sent.' };

  const rcpt = resolveRecipients({
    explicitTo: opts.to ?? null,
    customerEmail: doc.customer?.email ?? null,
    explicitCc: opts.cc,
    invoiceCc: doc.cc_emails,
    customerCc: doc.customer_cc_emails,
    copyToSelf: opts.copyToSelf ?? null,
  });
  if (!rcpt.ok) {
    return {
      ok: false, status: 422, code: rcpt.code,
      error: rcpt.code === 'CUSTOMER_EMAIL_MISSING'
        ? `${doc.customer?.name ?? 'This customer'} has no email address on file.`
        : rcpt.error,
    };
  }

  const wantExtra = (opts.attachmentIds ?? []).filter(Boolean);
  if (wantExtra.length && !doc.template.attachments_allowed) {
    return { ok: false, status: 422, code: 'ATTACHMENTS_NOT_ALLOWED', error: 'This invoice template does not send attachments. Turn it on in Invoices → Design.' };
  }
  const extra = await loadExtraAttachments(orgId, doc.id, wantExtra);
  if (!extra.ok) return { ok: false, status: 422, code: 'ATTACHMENT_FAILED', error: extra.error };

  const { subject, html, text, hasPayButton } = buildInvoiceEmail(doc, null, {
    message: opts.message ?? null,
    attachmentNames: extra.files.map((f) => f.filename),
  });
  if (opts.quotaUserId) {
    const quota = await consumeSendQuota(orgId, opts.quotaUserId, 1 + rcpt.cc.length + rcpt.bcc.length, 'invoice_send');
    if (!quota.ok) return { ok: false, status: quota.status, code: quota.code, error: quota.error };
  }

  const pdf = await renderToBuffer(InvoicePdf({ doc }));

  let sent;
  try {
    sent = await provider.send(
      {
        to: [rcpt.to],
        cc: rcpt.cc,
        bcc: rcpt.bcc,
        subject,
        html,
        text,
        attachments: [
          { filename: `invoice-${doc.invoice_number}.pdf`, content: new Uint8Array(pdf), contentType: 'application/pdf' },
          ...extra.files,
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
    meta: {
      to: rcpt.to,
      ...(rcpt.cc.length ? { cc: rcpt.cc } : {}),
      ...(rcpt.bcc.length ? { copy_to_sender: true } : {}),
      provider: sent.provider,
      message_id: sent.id,
      subject,
      pay_button: hasPayButton,
      template_id: doc.template.id,
      ...(extra.files.length ? { attachments: extra.files.map((f) => f.filename) } : {}),
    },
  });

  // invoices is SELECT-only for members (migration 176): the invoice was read through the
  // caller's client above (loadInvoiceDocById — RLS proved org + client scope), org pinned.
  const patch: Record<string, unknown> = {};
  if (doc.status === 'DRAFT') patch.status = 'SENT';
  if (!doc.status || doc.status === 'DRAFT' || doc.status === 'SENT') patch.sent_at = new Date().toISOString();
  if (opts.saveCcOnInvoice && opts.cc !== undefined) patch.cc_emails = rcpt.cc;
  if (Object.keys(patch).length) {
    await writerFor(supabase).from('invoices').update(patch).eq('id', doc.id).eq('org_id', orgId);
  }

  return {
    ok: true, status: 200, to: rcpt.to, cc: rcpt.cc, message_id: sent.id, provider: sent.provider,
    pay_url: doc.pay.url, payable: hasPayButton, attachments: extra.files.map((f) => f.filename),
  };
}
