export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { resRpc } from '@/lib/residential/rpc';
import { publicLink, tradeToken } from '@/lib/residential/sign';
import { Uuid } from '@/lib/residential/schemas';

/** Leveling grid: line × bidder, low / high, scope gaps, exclusions. */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: 'commitment' }, async ({ db, params }) =>
  resRpc(db, 'res_bid_leveling', { p_package: params.packageId! }));

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('invite'), vendorId: Uuid, contactId: Uuid.nullish() }),
  z.object({ op: z.literal('award'), inviteId: Uuid }),
  z.object({ op: z.literal('close') }),
]);

const OPS = { close: { cap: 'projects.commitments', action: 'edit' } } as const;

export const POST = route({ access: { cap: 'projects.commitments', action: 'create' }, ops: OPS, mask: 'commitment', body: Op }, async ({ req, db, params, body }) => {
  if (body.op === 'invite') {
    const t = tradeToken();
    return { inviteId: await resRpc<string>(db, 'res_invite_bidder', { p_package: params.packageId!, p_vendor: body.vendorId, p_contact: body.contactId ?? null, p_token_hash: t.hash, p_link: publicLink(linkBase(req), 'bid', t.token) }) };
  }
  // close bidding: no late bid, revision or decline is taken after this
  if (body.op === 'close') return { status: await resRpc<string>(db, 'res_start_leveling', { p_package: params.packageId! }) };
  return { commitmentId: await resRpc<string>(db, 'res_award_bid', { p_invite: body.inviteId }) };
});
