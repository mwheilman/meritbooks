export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadCustomerStatement, type StatementMode } from '@/lib/invoices/statement';
import { StatementPdf } from '@/lib/invoices/statement-pdf';
import { buildStatementEmail } from '@/lib/invoices/statement-email';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import { logHumanAction } from '@/lib/trust/action-log';
import { renderToBuffer } from '@react-pdf/renderer';

/**
 * POST /api/customers/[id]/statement/send — email the branded AR statement to
 * the customer, using the SAME provider transport as invoice send (Resend today;
 * MS Graph pluggable later). Guarded by requirePermission('invoices','view').
 *
 * GRACEFUL DEGRADE. If email isn't configured (no RESEND_API_KEY / no
 * INVOICE_FROM_EMAIL) we return a distinct, actionable 503 — never a silent
 * success. The SENT audit row is written ONLY after the provider confirms a
 * message id (the same discipline as invoice send; the reverse produced eight
 * "reported success while failing" defects in this codebase).
 *
 * There is no per-customer "statement event" table, so we record the send in the
 * human action log (core.action_log) — the suitable audit surface that exists —
 * rather than inventing a schema. Body (optional JSON): { mode, as_of, from, to }.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'view');
  if (!guard.ok) return guard.response;

  // Email configuration — surfaced distinctly from a send failure.
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

  const body = (await req.json().catch(() => ({}))) as {
    mode?: string; as_of?: string; from?: string; to?: string;
  };
  const mode: StatementMode = body.mode === 'activity' ? 'activity' : 'open';

  const doc = await loadCustomerStatement(supabase, orgId, params.id, {
    mode,
    asOf: normalizeDate(body.as_of) ?? undefined,
    from: normalizeDate(body.from) ?? undefined,
    to: normalizeDate(body.to) ?? undefined,
  });
  if (!doc) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const to = doc.customer.email;
  if (!to) {
    return NextResponse.json(
      { error: `${doc.customer.name || 'This customer'} has no email address on file.`, code: 'CUSTOMER_EMAIL_MISSING' },
      { status: 422 },
    );
  }

  const { subject, html, text } = buildStatementEmail(doc);
  const pdf = await renderToBuffer(<StatementPdf doc={doc} />);

  let sent;
  try {
    sent = await provider.send(
      {
        to: [to],
        subject,
        html,
        text,
        attachments: [
          { filename: `statement-${doc.asOf}.pdf`, content: new Uint8Array(pdf), contentType: 'application/pdf' },
        ],
      },
      from,
    );
  } catch (e) {
    const detail = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Unknown error';
    console.error('[statement send] provider rejected', doc.customer.name, detail);
    return NextResponse.json({ error: 'The email could not be sent.', code: 'EMAIL_SEND_FAILED', detail }, { status: 502 });
  }

  // Confirmed accepted, with a provider message id — now it's true. Best-effort
  // audit; never fail the send on a logging hiccup.
  await logHumanAction(supabase, userId, orgId, {
    action: 'customer.statement.send',
    subjectTable: 'customers',
    subjectId: doc.customer.id,
    summary: `Emailed ${mode === 'activity' ? 'activity' : 'open-item'} statement (${(doc.totalBalanceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} due) to ${doc.customer.name} at ${to}`,
  });

  return NextResponse.json({ sent: true, to, message_id: sent.id, provider: sent.provider });
}

function normalizeDate(v: string | undefined): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
