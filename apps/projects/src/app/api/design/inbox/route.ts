export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { inList, xcall, xrows } from '@/lib/dealer/rpc';
import { parseVendorEmail } from '@/lib/design/inbox-parse';
import { Req, Text, Uuid } from '@/lib/dealer/schemas';
import { todayIso } from '@/lib/time';

export interface InboxMessage {
  id: string;
  received_at: string;
  from_address: string;
  subject: string;
  kind: string;
  parsed: Record<string, unknown>;
  vendor_id: string | null;
  match_status: string;
  status: string;
}

export interface InboxProposal {
  id: string;
  message_id: string;
  target_table: string;
  target_id: string;
  job_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  confidence: number;
  needs_approval: boolean;
  status: string;
}

/** Forwarded vendor email: what each says, and the item changes it proposes (applied only by a person). */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: 'commitment', query: z.object({ company: Uuid, status: z.enum(['OPEN', 'ALL']).default('OPEN') }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  let q = pm.from('v_vendor_inbox_messages_masked').select('id, received_at, from_address, subject, kind, parsed, vendor_id, match_status, status').eq('location_id', query.company);
  if (query.status === 'OPEN') q = q.in('status', ['NEW', 'PROPOSED']);
  const messages = await xrows<InboxMessage>(q.order('received_at', { ascending: false }).limit(200), 'inbox');
  const proposals = await xrows<InboxProposal>(pm.from('v_vendor_inbox_proposals_masked').select('id, message_id, target_table, target_id, job_id, field, old_value, new_value, confidence, needs_approval, status').in('message_id', inList(messages.map((m) => m.id))).order('created_at'), 'proposals');
  return { messages, proposals: proposals.map((p) => ({ ...p, confidence: Number(p.confidence) })) };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ingest'), companyId: Uuid, from: Req(320, 'The sender'), subject: Text(500).default(''), body: z.string().max(200_000).default(''), attachmentIds: z.array(Uuid).max(20).default([]), poPrefixes: z.array(Text(10)).max(5).default(['PO-']) }),
  z.object({ op: z.literal('decide'), proposalId: Uuid, decision: z.enum(['apply', 'reject']) }),
  z.object({ op: z.literal('dismiss'), messageId: Uuid }),
]);

/**
 * Paste or forward a vendor email: the rules parser (lib/design/inbox-parse, no model) reads POs,
 * sidemarks, dates, tracking and prices; the database matches it to components and proposes
 * changes. The inbound-mail webhook that would call `ingest` automatically is a Books / platform
 * seam (see migration 1122).
 */
export const POST = route({ access: { cap: 'projects.selections', action: 'view' }, mask: 'commitment', body: Op }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'ingest': {
      assertCompany(tenant, body.companyId);
      const parsed = parseVendorEmail(body.subject, body.body, todayIso(), body.poPrefixes);
      const r = await xcall<Record<string, unknown>>(db, 'vi_ingest', { p_location: body.companyId, p_from: body.from, p_subject: body.subject, p_body: body.body, p_parsed: parsed, p_attachments: body.attachmentIds });
      return { ...r, parsed };
    }
    case 'decide':
      return xcall(db, 'vi_decide', { p_proposal: body.proposalId, p_decision: body.decision });
    case 'dismiss':
      return { id: await xcall<string>(db, 'vi_dismiss', { p_message: body.messageId }) };
  }
});
