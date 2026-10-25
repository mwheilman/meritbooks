export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { WaiverCreate } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/lien-waivers — request a waiver from a sub on the statutory form for the project state (CGC-46). */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: ['commitment'], body: WaiverCreate }, async ({ db, body }) => {
  return {
    id: await cmRpc<string>(db, 'cm_request_lien_waiver', {
      p_commitment: body.commitmentId, p_type: body.type, p_amount_cents: body.amountCents, p_through: body.through, p_sub_pay_app: body.subPayAppId, p_tier: body.tier, p_claimant: body.claimant,
    }, 'commitment'),
  };
});
