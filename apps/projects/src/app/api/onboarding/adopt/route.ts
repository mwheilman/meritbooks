/**
 * POST /api/onboarding/adopt — "Jobs already in Merit Books → Bring them over"
 *   body: { companyId, jobTypeKey? }
 *   → { status: 'done', adopted, failed, results[] } | { status: 'needs_rpc', waiting }
 *
 * A Books job (core.jobs) becomes a Projects job by getting its pm.projects extension.
 * Members cannot INSERT pm.projects (1100 §21 grants SELECT + column UPDATE only; the
 * integrity trigger also needs an installed job type), so this calls the definer RPC
 *   pm.adopt_job(p_job uuid, p_job_type_key text) returns uuid
 * which migration 1100 does NOT define yet. Until the lead adds it, the route answers
 * `needs_rpc` (HTTP 200) and the UI says so plainly; nothing is written.
 */
import { z } from 'zod';
import { companyJobTypes } from '@/lib/onboarding/load';
import { matchJobType } from '@/lib/onboarding/import/rows';
import { RouteError, dbError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({ companyId: z.string().uuid(), jobTypeKey: z.string().max(48).optional() });

interface JobRow { id: string; job_number: string; name: string; archetype: string | null; job_type: string | null }

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const types = await companyJobTypes(ctx.db, body.companyId);
    if (types.length === 0) throw new RouteError(409, 'NO_PACK', 'Set up this company first, then bring its jobs over.');
    if (body.jobTypeKey && !types.some((t) => t.key === body.jobTypeKey)) {
      throw new RouteError(422, 'UNKNOWN_JOB_TYPE', "That job type isn't set up on this company.");
    }

    const [{ data: jobs, error: jobsErr }, { data: projects }] = await Promise.all([
      ctx.db.schema('core').from('jobs').select('id, job_number, name, archetype, job_type').eq('location_id', body.companyId).limit(2000),
      ctx.db.schema('pm').from('projects').select('job_id').eq('location_id', body.companyId).limit(10_000),
    ]);
    if (jobsErr) throw dbError(jobsErr, 'Reading your Books jobs');
    const adopted = new Set(((projects ?? []) as { job_id: string }[]).map((p) => p.job_id));
    const todo = ((jobs ?? []) as JobRow[]).filter((j) => !adopted.has(j.id));
    if (todo.length === 0) return json({ status: 'done', adopted: 0, failed: 0, results: [] });

    const results: { jobId: string; jobNumber: string; name: string; ok: boolean; message: string | null }[] = [];
    for (const j of todo) {
      const jt = body.jobTypeKey
        ?? matchJobType(j.job_type ?? j.archetype, types)?.key
        ?? types.find((t) => t.archetype === j.archetype)?.key
        ?? types[0].key;
      const { error } = await ctx.db.schema('pm').rpc('adopt_job', { p_job: j.id, p_job_type_key: jt });
      if (error) {
        const e = dbError(error, 'Bringing a job over');
        if (e.code === 'RPC_MISSING') return json({ status: 'needs_rpc', waiting: todo.length });
        results.push({ jobId: j.id, jobNumber: j.job_number, name: j.name, ok: false, message: e.message });
      } else {
        results.push({ jobId: j.id, jobNumber: j.job_number, name: j.name, ok: true, message: null });
      }
    }
    return json({ status: 'done', adopted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  });
}
