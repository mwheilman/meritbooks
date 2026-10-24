export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import { DUNNING_LADDER, getDunningStage, type DunningStageKey } from '@/lib/collections/cadence';
import { brandedLetterHtml, emailBrandOf } from '@/lib/branding/email';

/**
 * POST /api/collections/send — SEND a human-approved dunning reminder.
 *
 * The second, human-gated rung of the draft→approve→send flow. The subject+body
 * come from the reviewed draft (AI-phrased or edited by the collector), so this
 * endpoint NEVER auto-sends unreviewed AI text. It:
 *   • requires the caller to hold the `invoices:create` permission (AR authority);
 *   • degrades gracefully when Resend/INVOICE_FROM_EMAIL are unset (503, distinct
 *     from a send failure) — nothing is recorded as sent that didn't leave;
 *   • records REMINDER_SENT to public.invoice_events (with the cadence stage so
 *     the next stage escalates) AND a HUMAN entry to the core.action_log audit
 *     rail, only AFTER the provider confirms acceptance with a message id.
 */

const STAGE_KEYS = new Set<string>(DUNNING_LADDER.map((s) => s.key));

export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // AR authority gate — sending a collections notice is an invoices action.
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  let body: { invoiceId?: string; subject?: string; body?: string; stage?: string; aiDrafted?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const { invoiceId } = body;
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const letter = typeof body.body === 'string' ? body.body.trim() : '';
  if (!invoiceId || !subject || !letter) {
    return NextResponse.json({ error: 'invoiceId, subject, and body are required.' }, { status: 422 });
  }
  const stageKey: DunningStageKey | null = body.stage && STAGE_KEYS.has(body.stage) ? (body.stage as DunningStageKey) : null;

  // Email transport — distinguish "not configured" from "send failed".
  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  if (!provider || !from) {
    return NextResponse.json(
      {
        error: 'Email is not configured.',
        code: 'EMAIL_NOT_CONFIGURED',
        detail: 'Set RESEND_API_KEY and INVOICE_FROM_EMAIL, and verify the sending domain.',
      },
      { status: 503 },
    );
  }

  const doc = await loadInvoiceDocById(supabase, orgId, invoiceId);
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (doc.status === 'PAID' || doc.status === 'VOIDED' || doc.status === 'WRITTEN_OFF' || doc.balance_cents <= 0) {
    return NextResponse.json({ error: 'This invoice has no open balance to remind on.', code: 'NOTHING_DUE' }, { status: 422 });
  }
  const to = doc.customer?.email;
  if (!to) {
    return NextResponse.json(
      { error: `${doc.customer?.name ?? 'This customer'} has no email address on file.`, code: 'CUSTOMER_EMAIL_MISSING' },
      { status: 422 },
    );
  }

  // Pay button only when the invoice can really be paid online (Slice 1B: never a dead link).
  const payUrl = doc.pay.payable && doc.template.show_pay_button ? doc.pay.url : null;

  let sent;
  try {
    sent = await provider.send(
      {
        to: [to],
        subject,
        // The issuing company's brand (FPB-branding): logo, brand rule, brand Pay button.
        html: brandedLetterHtml({
          bodyText: letter,
          senderName: doc.entity?.name ?? 'Accounts receivable',
          accent: doc.template.accent_color,
          brand: emailBrandOf(doc.brand),
          cta: payUrl ? { url: payUrl, label: 'Pay online' } : null,
        }),
        text: letter,
      },
      from,
    );
  } catch (e) {
    const detail = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Unknown error';
    console.error('[collections send] provider rejected', doc.invoice_number, detail);
    return NextResponse.json({ error: 'The reminder could not be sent.', code: 'EMAIL_SEND_FAILED', detail }, { status: 502 });
  }

  const stageLabel = stageKey ? getDunningStage(stageKey).label : 'Reminder';

  // Record ONLY after acceptance. The stage drives the next escalation.
  await recordInvoiceEvent(supabase, {
    orgId,
    invoiceId: doc.id,
    type: 'REMINDER_SENT',
    actor: userId,
    meta: {
      to,
      subject,
      provider: sent.provider,
      message_id: sent.id,
      stage: stageKey ?? 'MANUAL',
      tier: stageKey ?? 'MANUAL',
      channel: 'dunning',
      ai_drafted: body.aiDrafted === true,
      human_approved: true,
    },
  });

  await logHumanAction(supabase, userId, orgId, {
    action: 'collections.reminder.send',
    subjectTable: 'invoices',
    subjectId: doc.id,
    summary: `Sent ${stageLabel} dunning reminder for invoice ${doc.invoice_number} to ${doc.customer?.name ?? to}`,
    metadata: { stage: stageKey ?? 'MANUAL', to, message_id: sent.id, ai_drafted: body.aiDrafted === true },
  });

  return NextResponse.json({ sent: true, to, stage: stageKey, message_id: sent.id, provider: sent.provider, pay_url: payUrl });
}
