export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderToBuffer } from '@react-pdf/renderer';
import { apiHandler } from '@/lib/api-handler';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { InvoicePdf } from '@/lib/invoices/invoice-pdf';
import { buildInvoiceEmail } from '@/lib/invoices/invoice-email';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolveEmailProvider, resolveFromAddress, EmailSendError, headerSafe } from '@/lib/email/provider';
import { consumeSendQuota } from '@/lib/email/send-quota';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { createAdminSupabase } from '@/lib/supabase/server';

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
 * SECURITY (Wave 1 review): this route used to run on the service role with no session
 * or permission check, taking the tenant from the invoice row — anyone who could reach it
 * could email any tenant's customer. It now matches /send: org from the session,
 * invoices:create on the invoice's client, the invoice read through the member's RLS
 * client (org + client scope proven), the Pay button only from the resolved pay-link
 * state (doc.pay — never a hand-built URL), the send metered by the outbound quota, and
 * the real member recorded as the actor.
 *
 * Ordering mirrors /send exactly: the event is written ONLY after the provider
 * confirms acceptance with a message id. A failed send records nothing and
 * returns the real reason, so an invoice never claims a reminder it didn't send.
 */
const bodySchema = z
  .object({
    // Optional tier label (e.g. 'MANUAL', 'FIRST_NOTICE'), kept in the event meta so a
    // future dunning ladder can read history.
    tier: z.string().trim().regex(/^[A-Z0-9_]{1,40}$/).optional(),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // An empty body is allowed (one-click from the worklist).
  const raw = await req.text();
  const forward = new Request(req.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw.trim() ? raw : '{}',
  });
  return apiHandler(bodySchema, async (body, ctx) => {
    const { userId, orgId, supabase } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
    if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    const tier = body.tier ?? 'MANUAL';

    // Read through the member's RLS client: org + client scope proven by the database.
    const { data: inv } = await supabase
      .from('invoices')
      .select('id, location_id, status, balance_cents')
      .eq('org_id', orgId)
      .eq('id', params.id)
      .maybeSingle();
    const rec = inv as { id: string; location_id: string | null; status: string; balance_cents: number | string } | null;
    if (!rec) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const guard = await requirePermission(userId, 'invoices', 'create', { locationId: rec.location_id });
    if (!guard.ok) return guard.response;

    // Don't chase something that isn't owed.
    if (rec.status === 'PAID' || rec.status === 'VOIDED' || rec.status === 'WRITTEN_OFF' || Number(rec.balance_cents ?? 0) <= 0) {
      return NextResponse.json(
        { error: 'This invoice has no open balance to remind on.', code: 'NOTHING_DUE' },
        { status: 422 },
      );
    }

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

    const doc = await loadInvoiceDocById(supabase, orgId, rec.id);
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
    // The same people copied on the invoice are copied on its reminders (Slice 1B).
    const cc = (doc.cc_emails.length ? doc.cc_emails : doc.customer_cc_emails).filter((e) => e.toLowerCase() !== to.toLowerCase());

    const quota = await consumeSendQuota(orgId, userId, 1 + cc.length, 'invoice_remind');
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.error, code: quota.code },
        { status: quota.status, headers: { 'Retry-After': String(quota.retryAfterSec) } },
      );
    }

    // Reuse the branded invoice email (its Pay button comes from doc.pay: shown only when
    // the invoice is really payable online), then reframe the subject as a reminder so the
    // customer sees a nudge, not a duplicate first issuance.
    const built = buildInvoiceEmail(doc, null);
    const overdue = new Date(`${doc.due_date}T00:00:00`) < new Date();
    const subject = headerSafe(
      `${overdue ? 'Payment overdue' : 'Payment reminder'}: Invoice ${doc.invoice_number} from ${doc.entity?.name ?? 'your supplier'}`,
    );
    const pdf = await renderToBuffer(InvoicePdf({ doc }));

    let sent;
    try {
      sent = await provider.send(
        {
          to: [to],
          cc,
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
      actor: userId,
      meta: { to, ...(cc.length ? { cc } : {}), provider: sent.provider, message_id: sent.id, subject, tier, overdue, pay_button: built.hasPayButton },
    });

    await logHumanAction(createAdminSupabase(), userId, orgId, {
      action: 'invoice.remind',
      subjectTable: 'invoices',
      subjectId: doc.id,
      summary: `Sent payment reminder for invoice ${doc.invoice_number} to ${doc.customer?.name ?? to}`,
      locationId: rec.location_id,
    });

    return NextResponse.json({
      sent: true,
      to,
      cc,
      tier,
      message_id: sent.id,
      provider: sent.provider,
      pay_url: built.hasPayButton ? doc.pay.url : null,
      payable: built.hasPayButton,
    });
  })(forward);
}
