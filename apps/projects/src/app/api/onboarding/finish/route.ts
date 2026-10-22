/**
 * POST /api/onboarding/finish — finish one company (steps 3–4 done or skipped)
 *   body: { companyId, firstJobId?, sampleJobId?, mode }
 *   → { next: companyId | null, redirect: string | null }
 *
 * Marks the company's run COMPLETE/done (allowed by the 1100 policy). When an org-level
 * selection exists, `next` is the first selected company without an active install;
 * otherwise the org run is completed too and `redirect` lands on the first job (sample or
 * imported) or Home. Sets the active-company cookie so Home opens on this company.
 */
import { z } from 'zod';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/tenant';
import { RouteError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import { completeCompanyRun, openRun } from '@/lib/onboarding/runs';
import { denyUnless } from '@/lib/access/route-guard';

export const dynamic = 'force-dynamic';

const Body = z.object({
  companyId: z.string().uuid(),
  firstJobId: z.string().uuid().nullable().optional(),
  sampleJobId: z.string().uuid().nullable().optional(),
  mode: z.enum(['first', 'change']).default('first'),
});

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const denied = await denyUnless('projects.settings', 'configure', body.companyId); if (denied) return denied;
    const { data: inst } = await ctx.db.schema('pm').from('pack_installs').select('location_id')
      .eq('role', 'primary').eq('status', 'ACTIVE');
    const installed = new Set(((inst ?? []) as { location_id: string }[]).map((i) => i.location_id));
    if (!installed.has(body.companyId)) throw new RouteError(409, 'NOT_SET_UP', 'Set this company up first.');

    const err = await completeCompanyRun(ctx.db, body.companyId, {
      firstJobId: body.firstJobId ?? null, sampleJobId: body.sampleJobId ?? null,
    });
    if (err) console.warn('[onboarding/finish] could not complete run', err);

    let next: string | null = null;
    if (body.mode === 'first') {
      const org = await openRun(ctx.db, null);
      const selected = org?.inputs?.selectedCompanyIds ?? [];
      next = selected.find((id) => id !== body.companyId && !installed.has(id) && ctx.tenant.companies.some((c) => c.id === id)) ?? null;
      if (!next && org) await completeCompanyRun(ctx.db, null);
    }
    const redirect = next ? null : body.firstJobId ? `/jobs/${body.firstJobId}` : '/';
    const res = json({ next, redirect });
    res.cookies.set(ACTIVE_COMPANY_COOKIE, body.companyId, { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 60 * 60 * 24 * 365 });
    return res;
  });
}
