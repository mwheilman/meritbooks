export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError } from '@/lib/budgets/route-support';
import { listTemplates, saveTenantTemplate } from '@/lib/budgets/service/templates';
import { saveTemplateSchema, templatesQuery } from '@/lib/validations/budgets';

/**
 * GET  /api/budgets/templates?location_id — recommended (system) templates + this tenant's templates
 *      (latest version of each, with the version history).
 * POST — save a tenant template: a new key, or version n+1 of an existing key (old versions stay).
 */
export const GET = apiQueryHandler(templatesQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json({ ...(await listTemplates(b)), canEdit: b.access.scope === 'ALL' && b.access.canEdit });
  } catch (e) {
    return budgetError(e, 'templates GET');
  }
});

export const POST = apiHandler(saveTemplateSchema, async (i, ctx) => {
  const b = await budgetCtx(ctx, i.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const template = await saveTenantTemplate(
      b,
      { key: i.key, basedOn: i.based_on, name: i.name, departmentKind: i.department_kind, description: i.description, lines: i.lines.map((l) => ({ ...l, params: l.params ?? {} })), kpis: i.kpis },
      i.location_id,
    );
    return NextResponse.json({ template }, { status: 201 });
  } catch (e) {
    return budgetError(e, 'templates POST');
  }
});
