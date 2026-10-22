import { z } from 'zod';
import { route } from '@/lib/api';
import { call } from '@/lib/pm/ops/rpc';
import { Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), employeeId: Uuid.nullish() }),
  z.object({
    op: z.literal('complete'),
    actualMinutes: z.number().int().min(0).max(100_000),
    qtyGood: z.number().min(0).max(1e9).nullish(),
    qtyScrap: z.number().min(0).max(1e9).default(0),
    notes: Text(2000).nullish(),
  }),
  z.object({ op: z.literal('skip'), reason: Need(300, 'Say why the step is skipped') }),
]);

/** Shop-floor operation moves (pm.start_operation / complete_operation / skip_operation). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, ops: { skip: { cap: 'projects.production', action: 'edit' } }, mask: false, body: Op }, async ({ db, params, body }) => {
  switch (body.op) {
    case 'start':
      await call(db, 'start_operation', { p_op: params.opId!, p_employee: body.employeeId ?? null });
      return { ok: true };
    case 'complete': {
      const r = await call<{ work_order_status: string; remaining_operations: number }>(db, 'complete_operation', {
        p_op: params.opId!, p_actual_minutes: body.actualMinutes, p_qty_good: body.qtyGood ?? null, p_qty_scrap: body.qtyScrap, p_notes: body.notes || null,
      });
      return { ok: true, ...r };
    }
    case 'skip':
      await call(db, 'skip_operation', { p_op: params.opId!, p_reason: body.reason });
      return { ok: true };
  }
});
