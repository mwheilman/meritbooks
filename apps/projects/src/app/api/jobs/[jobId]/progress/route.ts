import { z } from 'zod';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';

/** Physical percent complete (pm.set_progress; only for PHYSICAL_PCT / UNITS contracts). */
export const POST = route(
  { body: z.object({ pct: z.number().min(0).max(1), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }) },
  async ({ db, params, body }) => {
    const job = await loadJob(db, params.jobId!);
    must(await db.schema('pm').rpc('set_progress', { p_job: job.job_id, p_pct: body.pct, p_as_of: body.asOf ?? null }), 'set progress');
    return { ok: true };
  },
);
