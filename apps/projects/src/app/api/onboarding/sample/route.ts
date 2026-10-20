/**
 * POST   /api/onboarding/sample  { companyId } → { jobId }               pm.load_sample_job(p_location)
 * DELETE /api/onboarding/sample  { companyId } → { removed, cancelled }  pm.remove_sample_data(p_location)
 *
 * One clearly labelled sample job per company (idempotent), built from the installed
 * pack's sample_job: customer, contract, budget by cost code, tasks, stage. Removal
 * deletes it, or cancels it if anything in Books already points at it.
 */
import { z } from 'zod';
import { dbError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';

export const dynamic = 'force-dynamic';

const Body = z.object({ companyId: z.string().uuid() });

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const { data, error } = await ctx.db.schema('pm').rpc('load_sample_job', { p_location: body.companyId });
    if (error || !data) throw dbError(error, 'Loading the sample job');
    return json({ jobId: data as string });
  });
}

export async function DELETE(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const { data, error } = await ctx.db.schema('pm').rpc('remove_sample_data', { p_location: body.companyId });
    if (error) throw dbError(error, 'Removing the sample job');
    const r = (data ?? {}) as { removed?: number; cancelled?: number };
    return json({ removed: r.removed ?? 0, cancelled: r.cancelled ?? 0 });
  });
}
