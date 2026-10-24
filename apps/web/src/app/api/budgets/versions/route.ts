export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { listVersions, loadDepartments } from '@/lib/budgets/service/data';
import { createVersion, updateVersionSettings } from '@/lib/budgets/service/versions';
import { canSeeDepartment } from '@/lib/budgets/scope';
import type { VersionsResponse } from '@/lib/budgets/types';
import { createVersionSchema, versionSettingsSchema, versionsQuery } from '@/lib/validations/budgets';

/**
 * GET   /api/budgets/versions?location_id&fiscal_year — the company-year's versions, the current
 *       (published) one, the caller's budget access and the departments they may see.
 * POST  — create a version: blank, copy, last year's actuals + x%, last year's budget + x%, or a
 *       reforecast (actuals through the closed month + budget after). Finance only.
 * PATCH — a draft version's settings (label, due date, materiality, notes). Finance only.
 */
export const GET = apiQueryHandler(versionsQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const [versions, departments] = await Promise.all([listVersions(b.reader, q.location_id, q.fiscal_year), loadDepartments(b.reader, q.location_id, b.orgId)]);
    const body: VersionsResponse = {
      versions,
      current: versions.find((v) => v.isCurrent) ?? null,
      access: b.access,
      departments: departments.filter((d) => canSeeDepartment(b.access, d.id)),
    };
    return NextResponse.json(body);
  } catch (e) {
    return budgetError(e, 'versions GET');
  }
});

export const POST = apiHandler(createVersionSchema, async (i, ctx) => {
  const b = await budgetCtx(ctx, i.location_id);
  if (b instanceof NextResponse) return b;
  try {
    const version = await createVersion(b, {
      locationId: i.location_id,
      fiscalYear: i.fiscal_year,
      kind: i.kind,
      start: i.start,
      label: i.label,
      sourceVersionId: i.source_version_id,
      growthBps: i.growth_bps,
      dueDate: i.due_date,
      closedThrough: i.closed_through,
      notes: i.notes,
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (e) {
    return budgetError(e, 'versions POST');
  }
});

export const PATCH = apiHandler(versionSettingsSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const version = await updateVersionSettings(b, i.version_id, {
      label: i.label,
      dueDate: i.due_date,
      materialityCents: i.materiality_cents,
      materialityBps: i.materiality_bps,
      notes: i.notes,
    });
    return NextResponse.json({ version });
  } catch (e) {
    return budgetError(e, 'versions PATCH');
  }
});
