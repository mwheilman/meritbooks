export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { PmQueryError } from '@/lib/api-errors';
import { addDays, todayIso } from '@/lib/time';
import { mondayOf } from '@/lib/pm/ops/week';
import { Day } from '../_lib/contract';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { applySingle } from '../_lib/single';

const Query = z.object({ weekStart: Day.optional() });

/** GET /api/field/time?weekStart=YYYY-MM-DD — my own time for a week (hours, cost code, state; no rates). */
export const GET = route({ access: { cap: 'projects.time', action: 'view' }, query: Query }, async ({ db, query, userId }) => {
  const start = mondayOf(query.weekStart ?? todayIso());
  const me = await db.schema('core').from('employees').select('id').eq('clerk_user_id', userId).eq('is_active', true).limit(1).maybeSingle();
  const empId = (me.data as { id: string } | null)?.id ?? null;
  const r = await db.schema('pm').from('v_time_entries_masked')
    .select('id, job_id, employee_id, work_date, hours, cost_code_id, notes, approval_state, source_ref, updated_at')
    .gte('work_date', start).lte('work_date', addDays(start, 6)).neq('approval_state', 'VOID')
    .or(empId ? `employee_id.eq.${empId},user_id.eq.${userId}` : `user_id.eq.${userId}`)
    .order('work_date').limit(500);
  if (r.error) throw new PmQueryError('my time', r.error);
  const entries = ((r.data ?? []) as Array<{ id: string; job_id: string; employee_id: string | null; work_date: string; hours: number | string; cost_code_id: string | null; notes: string | null; approval_state: string; source_ref: string | null; updated_at: string | null }>)
    .map((t) => ({ id: t.id, jobId: t.job_id, employeeId: t.employee_id, workDate: t.work_date, hours: Number(t.hours), costCodeId: t.cost_code_id, notes: t.notes, state: t.approval_state, commandRef: t.source_ref?.startsWith('wf:') ? t.source_ref : null, updatedAt: t.updated_at }));
  return { weekStart: start, entries, totalHours: Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100 };
});

/** POST /api/field/time — correct one of my entries (field-owned fields win until approved) or submit my week. */
export const POST = route({ access: { cap: 'projects.time', action: 'edit' }, mask: false, body: z.unknown() }, async (rc) => {
  return commandResponse(await applySingle(fieldCtx(rc), rc.body, ['time.update', 'time.submit']));
});
