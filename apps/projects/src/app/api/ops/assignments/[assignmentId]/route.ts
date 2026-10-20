import { z } from 'zod';
import { route } from '@/lib/api';
import { call } from '@/lib/pm/ops/rpc';

/** Technician clock states on one assignment (pm.set_assignment_status checks the move). */
export const POST = route(
  { body: z.object({ status: z.enum(['DISPATCHED', 'EN_ROUTE', 'ON_SITE', 'DONE', 'CANCELLED']) }) },
  async ({ db, params, body }) => {
    await call(db, 'set_assignment_status', { p_assignment: params.assignmentId!, p_status: body.status });
    return { ok: true };
  },
);
