export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { buildExportFilename } from '@/lib/reports/export/statement-model';
import { viewQueryRouteSchema } from '@/lib/fpna/workspace/query';
import { prepare } from '@/lib/fpna/workspace/server/load';
import { buildView } from '@/lib/fpna/workspace/server/views';
import { scopeLabelOf, WorkspacePdf } from '@/lib/fpna/workspace/server/pdf';
import { noOrg, serverCtx, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';
import { TAB_LABEL } from '@/lib/fpna/workspace/types';

/**
 * GET /api/fpna/workspace/export — the current /fpna view (dashboard or any tab) as a branded
 * PDF, rendered on the server from the SAME parameters as the view (AC-W11): the client sends
 * no figures. reports:export. Governed exactly like the view; a finance preview of unclosed
 * months is watermarked.
 */
export const GET = apiQueryHandler(viewQueryRouteSchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/fpna/workspace/export' });
  if (!guard.ok) return guard.response;
  try {
    const p = await prepare(serverCtx({ ...ctx, orgId: ctx.orgId }));
    const view = await buildView(p, q, { role: guard.role });
    const title = 'dashboard' in view ? view.dashboard.name : TAB_LABEL[view.tab];
    const pdf = await renderToBuffer(<WorkspacePdf view={view} scopeLabel={scopeLabelOf(view)} />);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${buildExportFilename(`fpna-${title}-${view.period.label}`, 'pdf')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/export');
  }
});
