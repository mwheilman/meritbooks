export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { applyTemplate, previewTemplate, startFromPriorYear } from '@/lib/budgets/service/templates';
import { startSchema } from '@/lib/validations/budgets';

/**
 * POST /api/budgets/lines/start — fill a department (or the company-level lines):
 *   mode PRIOR_YEAR  last year's actuals + growth_bps, month shape kept;
 *   mode TEMPLATE    a system / tenant template resolved against this chart (preview: true = no writes).
 */
export const POST = apiHandler(startSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    if (i.mode === 'PRIOR_YEAR') {
      return NextResponse.json(await startFromPriorYear(b, i.version_id, i.department_id, i.growth_bps ?? 0));
    }
    if (!i.template_id) return NextResponse.json({ error: 'Pick a template.', code: 'VALIDATION_ERROR' }, { status: 422 });
    const r = i.preview
      ? await previewTemplate(b, i.version_id, i.department_id, i.template_id, i.growth_bps ?? null, i.template_version)
      : await applyTemplate(b, i.version_id, i.department_id, i.template_id, i.growth_bps ?? null, i.template_version);
    return NextResponse.json(r);
  } catch (e) {
    return budgetError(e, 'lines/start');
  }
});
