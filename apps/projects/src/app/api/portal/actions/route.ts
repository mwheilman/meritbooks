export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { portalHandler } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { newToken, sha256Hex } from '@/lib/portal/tokens';

/**
 * PUBLIC (session cookie): every portal action. The database decides who may do what (grants,
 * role, can_sign, phone verification) and records it in pm.portal_actions; this route only
 * validates shapes and passes the caller's IP / browser for the audit trail.
 */
const id = z.string().uuid();
const docs = z.array(id).max(10).default([]);
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('decide'), orgId: id, kind: z.enum(['estimate', 'change_order', 'selection', 'draw']), id,
             decision: z.enum(['approved', 'declined']), typedName: z.string().trim().min(2).max(200), consent: z.literal(true),
             optionId: id.nullish(), comment: z.string().trim().max(2000).nullish(),
             lines: z.array(z.object({ line_id: id, approved_cents: z.number().int().min(0) })).max(200).nullish() }),
  z.object({ op: z.literal('sign'), orgId: id, signerId: id }),
  z.object({ op: z.literal('message'), orgId: id, jobId: id, audience: z.enum(['customer', 'vendor', 'lender', 'investor']),
             body: z.string().trim().min(1).max(4000), documents: docs }),
  z.object({ op: z.literal('request'), orgId: id, jobId: id, kind: z.enum(['warranty', 'service']), title: z.string().trim().min(2).max(200),
             description: z.string().trim().max(4000).nullish(), window: z.string().trim().max(200).nullish(), documents: docs }),
  z.object({ op: z.literal('task'), orgId: id, taskId: id, response: z.enum(['confirmed', 'declined', 'proposed']),
             proposedStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), note: z.string().trim().max(2000).nullish() }),
  z.object({ op: z.literal('accept'), orgId: id, commitmentId: id, typedName: z.string().trim().min(2).max(200), consent: z.literal(true) }),
  z.object({ op: z.literal('punch'), orgId: id, itemId: id, note: z.string().trim().max(1000).nullish(), documents: docs }),
  z.object({ op: z.literal('compliance'), orgId: id, kind: z.enum(['W9', 'COI', 'LIEN_WAIVER', 'OTHER']), documentId: id,
             complianceDocId: id.nullish(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }),
  z.object({ op: z.literal('pay_app'), orgId: id, commitmentId: id, periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
             invoiceNo: z.string().trim().max(60).nullish(), documentId: id.nullish(), note: z.string().trim().max(2000).nullish(),
             lines: z.array(z.object({ line_id: id, pct_complete: z.number().min(0).max(1) })).min(1).max(500) }),
]);

export const POST = portalHandler({ body: Body }, async ({ body: b, session, meta }) => {
  const s = { p_session: session, p_org: b.orgId };
  switch (b.op) {
    case 'decide':
      return portalRpc('decide', { ...s, p_kind: b.kind, p_id: b.id, p_decision: b.decision, p_typed_name: b.typedName,
        p_option: b.optionId ?? null, p_comment: b.comment ?? null, p_lines: b.lines ?? null, p_ip: meta.ip, p_user_agent: meta.userAgent });
    case 'sign': {
      const token = newToken();
      await portalRpc('esign_link', { ...s, p_signer: b.signerId, p_token_hash: sha256Hex(token), p_ip: meta.ip, p_user_agent: meta.userAgent });
      return { ok: true, url: `/sign/${token}` };
    }
    case 'message':
      return portalRpc('post_message', { ...s, p_job: b.jobId, p_audience: b.audience, p_body: b.body, p_documents: b.documents });
    case 'request':
      return portalRpc('service_request', { ...s, p_job: b.jobId, p_kind: b.kind, p_title: b.title, p_description: b.description ?? null,
        p_window: b.window ?? null, p_documents: b.documents });
    case 'task':
      return portalRpc('task_respond', { ...s, p_task: b.taskId, p_response: b.response, p_proposed_start: b.proposedStart ?? null, p_note: b.note ?? null });
    case 'accept':
      return portalRpc('accept_commitment', { ...s, p_commitment: b.commitmentId, p_typed_name: b.typedName, p_ip: meta.ip, p_user_agent: meta.userAgent });
    case 'punch':
      return portalRpc('punch_ready', { ...s, p_item: b.itemId, p_note: b.note ?? null, p_documents: b.documents });
    case 'compliance':
      return portalRpc('compliance_submit', { ...s, p_kind: b.kind, p_document: b.documentId, p_compliance_doc: b.complianceDocId ?? null,
        p_expires_on: b.expiresOn ?? null });
    case 'pay_app':
      return portalRpc('submit_pay_app', { ...s, p_commitment: b.commitmentId, p_lines: b.lines, p_period_end: b.periodEnd,
        p_invoice_no: b.invoiceNo ?? null, p_document: b.documentId ?? null, p_note: b.note ?? null });
  }
});
