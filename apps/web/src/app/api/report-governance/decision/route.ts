import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { applyGovernance } from '@/lib/reports/governance/apply';
import { governanceError, noOrg, PERIOD_KEY_RE } from '@/lib/reports/governance/http';
import { monthRange } from '@/lib/reports/governance/periods';

export const dynamic = 'force-dynamic';

const query = z
  .object({
    location_ids: z.string().min(1).max(4000),
    from: z.string().regex(PERIOD_KEY_RE),
    to: z.string().regex(PERIOD_KEY_RE),
    scope: z.enum(['company', 'combined', 'consolidated']).optional(),
    preview: z.enum(['0', '1']).optional(),
    pro_forma: z.enum(['0', '1']).optional(),
  })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] });

/**
 * GET /api/report-governance/decision — the governance decision for a report header / chart
 * footer (closed through, released / preview / hidden months, restated, watermark, banner,
 * footnote). Never returns figures. Audience is resolved server-side; preview / pro forma
 * are honoured for finance only.
 */
export const GET = apiQueryHandler(query, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const reports = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/report-governance/decision' });
  if (!reports.ok) {
    const biz = await requirePermission(ctx.userId, 'biz_reports', 'view', { route: '/api/report-governance/decision' });
    if (!biz.ok) return biz.response;
  }
  const ids = Array.from(new Set(q.location_ids.split(',').map((s) => s.trim()).filter(Boolean)));
  if (ids.length === 0 || ids.length > 200 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    return NextResponse.json({ error: 'location_ids must be 1–200 company ids', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const periods = monthRange(q.from, q.to);
  if (periods.length > 120) return NextResponse.json({ error: 'At most 120 months', code: 'VALIDATION_ERROR' }, { status: 422 });
  try {
    const decision = await applyGovernance(
      { periods, locationIds: ids, scopeKind: q.scope ?? (ids.length === 1 ? 'company' : 'combined') },
      { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, includePreview: q.preview !== '0', proForma: q.pro_forma === '1' },
    );
    return NextResponse.json(decision);
  } catch (e) {
    return governanceError(e);
  }
});
