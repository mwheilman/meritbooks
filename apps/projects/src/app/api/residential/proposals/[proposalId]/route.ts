export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { SignerInput } from '@/lib/esign/types';
import { pm } from '@/lib/pm/db';
import { loadProposal } from '@/lib/residential/queries';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { sendProposalForSignature } from '@/lib/residential/sign';
import { MethodZ, PaymentRowZ, ProposalAttrsZ, Text, Uuid, attrsToDb } from '@/lib/residential/schemas';

export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: ['estimate', 'billing'] }, async ({ db, params }) =>
  loadProposal(db, params.proposalId!));

const Patch = ProposalAttrsZ.extend({ title: Text(200).min(1).optional() });

/** Edit a DRAFT's header (the database refuses a sent proposal: revise it). Totals follow at once. */
export const PATCH = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: Patch }, async ({ db, params, body }) => {
  const { title, ...attrs } = body;
  const patch: Record<string, unknown> = attrsToDb(attrs);
  if (title !== undefined) patch.title = title;
  if (!Object.keys(patch).length) return { ok: true };
  resWrote(await pm(db).from('res_proposals').update(patch).eq('id', params.proposalId!).select('id'));
  return { ok: true };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send') }),
  z.object({ op: z.literal('revise') }),
  z.object({ op: z.literal('decline'), reason: Text(1000).nullish() }),
  z.object({ op: z.literal('accept'), signerName: Text(200).min(1, 'The homeowner’s name is required'), method: MethodZ.default('IN_PERSON'), optionIds: z.array(Uuid).max(100).nullish() }),
  z.object({ op: z.literal('options'), optionIds: z.array(Uuid).max(100) }),
  z.object({ op: z.literal('schedule'), rows: z.array(PaymentRowZ).min(1).max(30) }),
  z.object({ op: z.literal('catalog'), catalogItemId: Uuid.nullish(), assemblyId: Uuid.nullish(), qty: z.number().positive().max(1e7), optionId: Uuid.nullish(), room: Text(80).nullish() }),
  z.object({ op: z.literal('sign'), signers: z.array(SignerInput).min(1).max(4), message: Text(2000).optional() }),
  z.object({ op: z.literal('viewed') }),
  z.object({ op: z.literal('tax') }),
]);

export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: ['estimate', 'billing'], body: Op }, async ({ req, db, params, body, tenant, userId }) => {
  const id = params.proposalId!;
  switch (body.op) {
    case 'send': return resRpc(db, 'res_send_proposal', { p_proposal: id });
    case 'revise': return { estimateId: await resRpc<string>(db, 'res_revise_proposal', { p_proposal: id }) };
    case 'decline': return { proposalId: await resRpc<string>(db, 'res_decline_proposal', { p_proposal: id, p_reason: body.reason ?? null }) };
    case 'accept': return resRpc(db, 'res_accept_proposal', { p_proposal: id, p_signer_name: body.signerName, p_method: body.method, p_option_ids: body.optionIds ?? null, p_signature_document: null });
    case 'options': return { updated: await resRpc<number>(db, 'res_select_options', { p_proposal: id, p_option_ids: body.optionIds }) };
    case 'schedule':
      return { rows: await resRpc<number>(db, 'res_set_payment_schedule', { p_proposal: id, p_items: body.rows.map((r) => ({
        label: r.label, kind: r.kind, pct: r.pct ?? null, amount_cents: r.amountCents ?? null, trigger_ref: r.triggerRef ?? null,
        requires_photo: r.requiresPhoto ?? false, requires_checklist: r.requiresChecklist ?? false })) }) };
    case 'catalog':
      if (!!body.catalogItemId === !!body.assemblyId) throw new HttpError(422, 'Add one catalog item or one assembly.', 'VALIDATION');
      return { added: await resRpc<number>(db, 'res_add_catalog_lines', { p_proposal: id, p_catalog_item: body.catalogItemId ?? null, p_assembly: body.assemblyId ?? null, p_qty: body.qty, p_option: body.optionId ?? null, p_room: body.room ?? null }) };
    case 'sign': {
      const r = await sendProposalForSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, id, body.signers, body.message);
      return { envelopeId: r.envelopeId, fileId: r.fileId, deliveries: r.deliveries.map((d) => ({ name: d.name, channel: d.channel, link: d.link })) };
    }
    case 'viewed': await resRpc(db, 'res_mark_proposal_viewed', { p_proposal: id }); return { ok: true };
    case 'tax': return resRpc(db, 'res_tax_preview', { p_proposal: id });
  }
});
