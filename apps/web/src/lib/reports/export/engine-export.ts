/**
 * Governed engine exports (server only). An engine statement is exported by RE-RUNNING it
 * server-side from the request parameters — the same path as POST /api/reports/engine/run
 * (client scope → load → governance) — and converting the GOVERNED result to the export
 * model. A client-sent model / rows are never rendered for an engine statement, so an export
 * can never contain a figure, or lose a watermark / banner / footnote, the screen would not.
 */
import { z } from 'zod';
import { reportRequestSchema } from '@/lib/reports/engine/schema';
import { toStatementModel } from '@/lib/reports/engine/to-model';
import type { EngineContext } from '@/lib/reports/engine/adapter';
import type { ReportRequest } from '@/lib/reports/engine/types';
import type { StatementModel } from './statement-model';

export const engineExportSchema = z.object({
  /** the ReportRequest the viewer ran (same shape as /api/reports/engine/run) */
  engine: reportRequestSchema,
  /** row ids the viewer has collapsed (their children are left out of the export) */
  collapsed: z.array(z.string().max(200)).max(5000).optional(),
  hideZero: z.boolean().optional(),
  /** xlsx only: prepend an executive summary sheet */
  summary: z.boolean().optional(),
});

export type EngineExportBody = z.infer<typeof engineExportSchema>;

/** Does this body ask for a governed engine export ({ engine: ReportRequest, … })? */
export function isEngineExportBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body) && 'engine' in (body as Record<string, unknown>);
}

/** Re-run the statement as the caller (governed) and build the export model from the result. */
export async function governedStatementModel(ctx: EngineContext, body: EngineExportBody): Promise<StatementModel> {
  const { runReport } = await import('@/lib/reports/engine/adapter');
  const result = await runReport(ctx, body.engine as ReportRequest);
  return toStatementModel(result, { collapsed: new Set(body.collapsed ?? []), hideZero: body.hideZero });
}
