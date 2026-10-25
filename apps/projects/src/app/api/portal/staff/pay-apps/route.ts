export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { decidePayApp, listPayApps } from '@/lib/portal/staff';

/** GET ?jobId|commitmentId — sub pay applications from the portal. POST — approve / reject (with a reason the sub sees). */
const Query = z.object({ jobId: z.string().uuid().optional(), commitmentId: z.string().uuid().optional() });
const Body = z.object({ id: z.string().uuid(), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(2000).nullish() });

export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['commitment', 'sub_pay_app'], query: Query }, async ({ db, query }) => ({ payApps: await listPayApps(db, query) }));
export const POST = route({ access: { cap: 'projects.commitments', action: 'approve' }, mask: false, body: Body }, async ({ db, body }) => {
  await decidePayApp(db, body);
  return { ok: true };
});
