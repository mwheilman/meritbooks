export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { renderToBuffer } from '@react-pdf/renderer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { StatementPdf } from '@/lib/reports/export/statement-pdf';
import { statementModelSchema, buildExportFilename, stampUngoverned, type StatementModel } from '@/lib/reports/export/statement-model';
import { engineExportSchema, governedStatementModel, isEngineExportBody } from '@/lib/reports/export/engine-export';
import { engineErrorResponse, validationResponse } from '@/lib/reports/engine/http';

/**
 * POST /api/reports/export/pdf — render a financial statement to a branded PDF
 * (FPB Dimension 7).
 *
 *  - ENGINE statements: body { engine: ReportRequest, collapsed?, hideZero? }. The server
 *    RE-RUNS the report as the caller (client scope + number governance, exactly like
 *    /api/reports/engine/run) and renders the governed result with its watermark, banner and
 *    footnote. reports:export. A client-sent model is never rendered for an engine statement.
 *  - LEGACY statements (pre-engine report pages, borrowing base, dealer reports) still send
 *    the StatementModel they built from data they fetched under RLS. Any governance marks in
 *    it are discarded and the PDF is stamped "not a released (governed) statement".
 */
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  let model: StatementModel;
  if (isEngineExportBody(body)) {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
    const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/reports/export/pdf' });
    if (!guard.ok) return guard.response;
    const parsed = engineExportSchema.safeParse(body);
    if (!parsed.success) return validationResponse(parsed.error);
    try {
      model = await governedStatementModel({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId }, parsed.data);
    } catch (e) {
      return engineErrorResponse(e);
    }
  } else {
    const parsed = statementModelSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid statement model', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
        { status: 422 },
      );
    }
    model = stampUngoverned(parsed.data);
  }

  const buffer = await renderToBuffer(<StatementPdf model={model} />);
  const filename = buildExportFilename(model.title, 'pdf');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
