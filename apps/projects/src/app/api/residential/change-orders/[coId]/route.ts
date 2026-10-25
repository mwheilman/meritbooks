export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { SignerInput } from '@/lib/esign/types';
import { resRpc } from '@/lib/residential/rpc';
import { sendChangeOrderForSignature } from '@/lib/residential/sign';
import { CoLineZ, MethodZ, Text, coLineToDb } from '@/lib/residential/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('price'), lines: z.array(CoLineZ).min(1).max(100), scheduleDays: z.number().int().min(-365).max(365).nullish() }),
  z.object({ op: z.literal('sign'), signerName: Text(200).min(1, 'Who signed?'), method: MethodZ.default('IN_PERSON') }),
  z.object({ op: z.literal('send'), signers: z.array(SignerInput).min(1).max(4), fast: z.boolean().default(false) }),
  z.object({ op: z.literal('trade_cos') }),
]);

/**
 * Change-order steps beyond 1100's stages: price from lines (PM, sell side), the homeowner signs on
 * the tablet or by a fast-sign text link (demo discovery: work resumes the same day), approval
 * through the approvals engine, and matching trade change orders on the commitments it touches.
 */
export const POST = route({
  access: { cap: 'projects.change_orders', action: 'edit' }, mask: ['change_order', 'commitment'], body: Op,
  ops: { trade_cos: { cap: 'projects.commitments', action: 'create' } },
}, async ({ req, db, params, body, tenant, userId }) => {
  const co = params.coId!;
  switch (body.op) {
    case 'price': return resRpc(db, 'res_price_change_order', { p_co: co, p_lines: body.lines.map(coLineToDb), p_schedule_days: body.scheduleDays ?? null });
    case 'sign': return resRpc(db, 'res_record_co_signature', { p_co: co, p_signer_name: body.signerName, p_method: body.method, p_signature_document: null });
    case 'send': {
      const r = await sendChangeOrderForSignature({ db, orgId: tenant.orgId, userId, baseUrl: linkBase(req) }, co, body.signers, body.fast);
      return { envelopeId: r.envelopeId, deliveries: r.deliveries.map((d) => ({ name: d.name, channel: d.channel, link: d.link })) };
    }
    case 'trade_cos': return { drafts: await resRpc<unknown[]>(db, 'res_propose_trade_cos', { p_co: co }) };
  }
});
