export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { buildStatementSummary } from '@/lib/reports/export/build-model';
import { statementModelSchema, buildExportFilename, stampUngoverned, type StatementModel } from '@/lib/reports/export/statement-model';
import { engineExportSchema, governedStatementModel, isEngineExportBody } from '@/lib/reports/export/engine-export';
import { engineErrorResponse, validationResponse } from '@/lib/reports/engine/http';

/**
 * POST /api/reports/export/xlsx — render financial statements to a genuine .xlsx workbook
 * (one worksheet per model; money as true numeric cells; text cells are inline strings, so a
 * label can never execute as a formula).
 *
 *  - ENGINE statements: body { engine: ReportRequest, collapsed?, hideZero?, summary? }. The
 *    server RE-RUNS the report as the caller (client scope + number governance, like
 *    /api/reports/engine/run) and writes the governed result with its governance marks.
 *    reports:export. A client-sent model is never written for an engine statement.
 *  - LEGACY statements: a single StatementModel, OR { title?, sheets: StatementModel[] },
 *    built by the client from data it fetched under RLS. Governance marks in it are
 *    discarded and every sheet is stamped "not a released (governed) statement".
 */
const multiSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  sheets: z.array(statementModelSchema).min(1).max(50),
});

export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  let models: StatementModel[];
  let title: string;
  if (isEngineExportBody(body)) {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
    const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/reports/export/xlsx' });
    if (!guard.ok) return guard.response;
    const parsed = engineExportSchema.safeParse(body);
    if (!parsed.success) return validationResponse(parsed.error);
    try {
      const model = await governedStatementModel({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId }, parsed.data);
      models = parsed.data.summary && model.columns.length > 1 ? [{ ...buildStatementSummary(model), watermark: model.watermark, banner: model.banner, footnote: model.footnote }, model] : [model];
      title = model.title;
    } catch (e) {
      return engineErrorResponse(e);
    }
  } else {
    // Accept a single StatementModel or { title?, sheets: StatementModel[] }.
    const single = statementModelSchema.safeParse(body);
    if (single.success) {
      models = [stampUngoverned(single.data)];
      title = single.data.title;
    } else {
      const multi = multiSchema.safeParse(body);
      if (!multi.success) {
        return NextResponse.json(
          { error: 'Invalid statement model', code: 'VALIDATION_ERROR', details: multi.error.flatten().fieldErrors },
          { status: 422 },
        );
      }
      models = multi.data.sheets.map(stampUngoverned);
      title = multi.data.title ?? 'report-pack';
    }
  }

  const buffer = workbookFromModels(models);
  const filename = buildExportFilename(title, 'xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
