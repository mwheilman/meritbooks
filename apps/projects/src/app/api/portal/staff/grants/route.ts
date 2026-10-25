export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { InviteBody, invite, listGrants } from '@/lib/portal/staff';

/**
 * GET  /api/portal/staff/grants?jobId|customerId|vendorId|companyId — who has portal access (RLS).
 * POST /api/portal/staff/grants — "Invite to portal": customer (customers:edit), sub / vendor
 * (commitments:edit), lender / investor (billing:edit). The invitation goes through the
 * notifications service and is held until the company goes live.
 */
const Query = z.object({ jobId: z.string().uuid().optional(), customerId: z.string().uuid().optional(), vendorId: z.string().uuid().optional(), companyId: z.string().uuid().optional() });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => ({ grants: await listGrants(db, query) }));

export const POST = route({
  access: { cap: 'projects.jobs', action: 'view' },
  ops: {
    invite_customer: { cap: 'projects.customers', action: 'edit' },
    invite_vendor: { cap: 'projects.commitments', action: 'edit' },
    invite_lender: { cap: 'projects.billing', action: 'edit' },
    invite_investor: { cap: 'projects.billing', action: 'edit' },
  },
  mask: false,
  body: InviteBody,
}, async ({ db, body }) => ({ ok: true, ...(await invite(db, body)) }));
