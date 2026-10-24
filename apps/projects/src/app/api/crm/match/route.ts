export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { MatchQuery } from '@/lib/parties/match';
import { matchParties } from '@/lib/parties/server';

/**
 * Matching at the door (SHARED-RECORDS §3): ranked candidates for what a create form has typed so
 * far. A read, so it is allowed in the consolidated view; the kind decides the grant.
 */
export const POST = route(
  {
    access: 'none',
    ops: {
      customer: { cap: 'projects.customers', action: 'view' },
      contact: { cap: 'projects.customers', action: 'view' },
      vendor: { cap: 'projects.commitments', action: 'view' },
    },
    mask: false,
    allowReadOnly: true,
    body: MatchQuery,
  },
  async ({ db, body }) => ({
    candidates: await matchParties(db, body.op, { name: body.name, email: body.email, phone: body.phone, address: body.address, taxId: body.taxId }, body.limit),
  }),
);
