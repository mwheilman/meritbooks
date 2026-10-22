/**
 * POST /api/onboarding/companies — step 0 "Which companies run jobs?"
 *   body: { companyIds: string[] }  (operating companies only; ≥ 1)
 *   → { selected: string[], next: string | null }
 * Saved on the org-level onboarding run (location_id null) so a reload resumes.
 */
import { z } from 'zod';
import { RouteError, json, withOnboarding } from '@/lib/onboarding/route';
import { saveRunInputs } from '@/lib/onboarding/runs';
import { denyUnless } from '@/lib/access/route-guard';

export const dynamic = 'force-dynamic';

const Body = z.object({ companyIds: z.array(z.string().uuid()).min(1).max(100) });

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    const denied = await denyUnless('projects.settings', 'configure'); if (denied) return denied;
    const known = new Set(ctx.tenant.companies.map((c) => c.id));
    const selected = [...new Set(body.companyIds)].filter((id) => known.has(id));
    if (selected.length === 0) throw new RouteError(422, 'NO_COMPANIES', 'Pick at least one company that runs jobs.');
    const order = ctx.tenant.companies.map((c) => c.id).filter((id) => selected.includes(id));
    const runId = await saveRunInputs(ctx.db, null, { selectedCompanyIds: order });
    if (!runId) throw new RouteError(500, 'RUN_SAVE', "We couldn't save that choice. Try again.");
    return json({ selected: order, next: order[0] ?? null });
  });
}
