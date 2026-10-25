export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { PmQueryError } from '@/lib/api-errors';
import { setClientVisible } from '@/lib/portal/staff';

/** POST — show / hide a schedule task or a daily-log entry on the customer portal. */
const Body = z.object({ table: z.enum(['tasks', 'field_logs']), id: z.string().uuid(), visible: z.boolean() });

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => ({
  ok: true, visible: await setClientVisible(db, body.table, body.id, body.visible),
}));

/** GET ?table=&ids=a,b — whether each task / daily-log entry shows on the customer portal (RLS: reachable jobs only). */
const Query = z.object({
  table: z.enum(['tasks', 'field_logs']),
  ids: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(200)),
});

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => {
  // tasks are read through the masked view (billing amounts stay hidden); field logs have no money
  const from = query.table === 'tasks' ? 'v_tasks_masked' : 'field_logs';
  const r = await db.schema('pm').from(from).select('id, client_visible').in('id', query.ids);
  if (r.error) throw new PmQueryError(from, r.error);
  return { visible: Object.fromEntries(((r.data ?? []) as Array<{ id: string; client_visible: boolean | null }>).map((x) => [x.id, x.client_visible === true])) };
});
