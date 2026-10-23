export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentUser } from '@clerk/nextjs/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { emailConfigStatus } from '@/lib/email/provider';
import { requirePermission } from '@/lib/rbac/require-permission';
import { sendInvoiceById } from '@/lib/invoices/send-invoice';
import { parseEmailList, MAX_CC } from '@/lib/invoices/recipients';
import { logHumanAction } from '@/lib/trust/action-log';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * POST /api/invoices/[id]/send — email the invoice to the customer.
 *
 * Body (all optional): { to, cc[] | "a@x, b@y", copy_to_me, message, attachment_ids[],
 * save_cc } — the Send dialog. With no body it sends to the customer's email on file
 * plus the saved CC lists (invoice + customer default).
 *
 * SECURITY (Slice 1B): this route used to run on the service role with NO session or
 * permission check, taking the tenant from the invoice row — anyone who could reach it
 * could email any tenant's invoice. It now runs as the signed-in member: org from the
 * session, invoices:create required, and the invoice is read through the member's RLS
 * client (org + client scope proven) before anything is sent.
 */
const bodySchema = z.object({
  to: z.string().trim().max(254).optional().nullable(),
  cc: z.union([z.array(z.string().trim().max(254)).max(MAX_CC + 5), z.string().max(3000)]).optional(),
  copy_to_me: z.boolean().optional(),
  message: z.string().max(4000).optional().nullable(),
  attachment_ids: z.array(z.string().uuid()).max(10).optional(),
  save_cc: z.boolean().optional(),
}).strict();

/**
 * GET /api/invoices/[id]/send — what the Send dialog starts with: the customer's email,
 * the saved CC list (invoice → customer default), whether the template allows
 * attachments and which documents are on the invoice, whether email is configured, and
 * whether the email will carry a Pay button.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return apiQueryHandler(null, async (_q, ctx) => {
    const { supabase, orgId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    const { data: inv } = await supabase
      .from('invoices').select('id, location_id').eq('org_id', orgId).eq('id', params.id).maybeSingle();
    const row = inv as { id: string; location_id: string | null } | null;
    if (!row) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    // The dialog shows the customer's email, CC list and attached documents: invoices:view.
    const guard = await requirePermission(ctx.userId, 'invoices', 'view', { locationId: row.location_id });
    if (!guard.ok) return guard.response;
    const doc = await loadInvoiceDocById(supabase, orgId, row.id);
    if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    const { data: docs } = await supabase
      .from('documents')
      .select('id, file_name, size_bytes, mime_type')
      .eq('org_id', orgId)
      .eq('entity_type', 'invoice')
      .eq('entity_id', doc.id)
      .order('created_at', { ascending: false })
      .limit(25);
    const email = emailConfigStatus();
    return NextResponse.json({
      to: doc.customer?.email ?? null,
      customerName: doc.customer?.name ?? null,
      cc: doc.cc_emails.length ? doc.cc_emails : doc.customer_cc_emails,
      message: doc.customer_message,
      attachmentsAllowed: doc.template.attachments_allowed,
      documents: (docs ?? []).map((d: { id: string; file_name: string; size_bytes: number | null; mime_type: string | null }) => ({
        id: d.id, name: d.file_name, sizeBytes: Number(d.size_bytes ?? 0), mimeType: d.mime_type,
      })),
      payButton: doc.pay.payable && doc.template.show_pay_button,
      payReason: doc.pay.reason,
      email: { configured: email.configured, reason: email.reason },
      templateName: doc.template.name,
    });
  })(req);
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // An empty body is allowed (one-click Send from the list / recurring parity).
  const raw = await req.text();
  const forward = new Request(req.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw.trim() ? raw : '{}',
  });
  return apiHandler(bodySchema, async (body, ctx) => {
    const { userId, orgId, supabase } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const { data: inv } = await supabase
      .from('invoices').select('id, location_id').eq('org_id', orgId).eq('id', params.id).maybeSingle();
    const row = inv as { id: string; location_id: string | null } | null;
    if (!row) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const guard = await requirePermission(userId, 'invoices', 'create', { locationId: row.location_id });
    if (!guard.ok) return guard.response;

    let copyToSelf: string | null = null;
    if (body.copy_to_me) {
      const u = await currentUser().catch(() => null);
      copyToSelf = u?.primaryEmailAddress?.emailAddress ?? null;
      if (!copyToSelf) return NextResponse.json({ error: 'Your account has no email address to copy you on.', code: 'NO_SENDER_EMAIL' }, { status: 422 });
    }

    const result = await sendInvoiceById(supabase, orgId, row.id, userId, {
      to: body.to ?? null,
      cc: body.cc === undefined ? undefined : parseEmailList(body.cc),
      copyToSelf,
      message: body.message ?? null,
      attachmentIds: body.attachment_ids ?? [],
      saveCcOnInvoice: body.save_cc ?? body.cc !== undefined,
      quotaUserId: userId,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.detail ? { detail: result.detail } : {}) },
        { status: result.status },
      );
    }

    await logHumanAction(createAdminSupabase(), userId, orgId, {
      action: 'invoice.send',
      subjectTable: 'invoices',
      subjectId: row.id,
      summary: `Sent invoice to ${result.to}${result.cc?.length ? ` (cc ${result.cc.join(', ')})` : ''}`,
    });

    return NextResponse.json({
      sent: true,
      to: result.to,
      cc: result.cc,
      message_id: result.message_id,
      provider: result.provider,
      pay_url: result.pay_url,
      payable: result.payable,
      attachments: result.attachments,
    });
  })(forward);
}
