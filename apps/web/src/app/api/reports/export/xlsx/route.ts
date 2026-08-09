export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { statementModelSchema, buildExportFilename, type StatementModel } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/export/xlsx — render one or more financial-statement models to
 * a genuine .xlsx workbook (one worksheet per model). Mirrors /export/pdf: the
 * client sends the SAME StatementModel(s) it built from the report data it already
 * fetched (under RLS) and is displaying, so the spreadsheet ties out to the screen.
 * No GL is re-queried here, so there is nothing tenant-sensitive to leak — the route
 * only needs an authenticated user. Money arrives as bigint cents in the model and
 * is written as true numeric dollar cells with an accounting number format.
 *
 * Body: a single StatementModel, OR { title?, sheets: StatementModel[] }.
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

  // Accept a single StatementModel or { title?, sheets: StatementModel[] }.
  let models: StatementModel[];
  let title: string;
  const single = statementModelSchema.safeParse(body);
  if (single.success) {
    models = [single.data];
    title = single.data.title;
  } else {
    const multi = multiSchema.safeParse(body);
    if (!multi.success) {
      return NextResponse.json(
        { error: 'Invalid statement model', code: 'VALIDATION_ERROR', details: multi.error.flatten().fieldErrors },
        { status: 422 },
      );
    }
    models = multi.data.sheets;
    title = multi.data.title ?? 'report-pack';
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
