import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Weather = z.object({
  conditions: Text(80).nullish(),
  highF: z.number().int().min(-80).max(140).nullish(),
  lowF: z.number().int().min(-80).max(140).nullish(),
  precipitation: Text(40).nullish(),
  delay: z.boolean().optional(),
});

const Body = z.object({
  jobId: Uuid,
  logDate: Day,
  kind: z.enum(['DAILY', 'INSPECTION', 'SAFETY', 'DELIVERY', 'VISIT']).default('DAILY'),
  body: Text(8000).nullish(),
  weather: Weather.nullish(),
  crewCount: z.number().int().min(0).max(10_000).nullish(),
  hours: z.number().min(0).max(100_000).nullish(),
});

/** weather jsonb keys as stored: conditions, high_f, low_f, precipitation, delay. */
function weatherJson(w: z.infer<typeof Weather> | null | undefined): Record<string, unknown> | null {
  if (!w) return null;
  const out: Record<string, unknown> = {};
  if (w.conditions) out.conditions = w.conditions;
  if (w.highF != null) out.high_f = w.highF;
  if (w.lowF != null) out.low_f = w.lowF;
  if (w.precipitation) out.precipitation = w.precipitation;
  if (w.delay) out.delay = true;
  return Object.keys(out).length ? out : null;
}

export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  if (!body.body && !body.crewCount && !body.hours && !weatherJson(body.weather)) {
    throw new HttpError(422, 'Write what happened, or record the crew, hours or weather.', 'VALIDATION');
  }
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('field_logs').insert({
      job_id: job.job_id, log_date: body.logDate, kind: body.kind, body: body.body || null, weather: weatherJson(body.weather),
      crew_count: body.crewCount ?? null, hours: body.hours ?? null,
    }).select('id'),
    'add daily log',
  );
  if (!r[0]) throw new HttpError(500, 'The log was not saved. Try again.', 'CREATE_FAILED');
  return { logId: r[0].id };
});
