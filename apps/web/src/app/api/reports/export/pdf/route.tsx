export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { renderToBuffer } from '@react-pdf/renderer';
import { StatementPdf } from '@/lib/reports/export/statement-pdf';
import { statementModelSchema, buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/export/pdf — render a financial statement to a branded PDF
 * (FPB Dimension 7). The client sends a StatementModel it already built from the
 * report data it fetched (under RLS) and is displaying; the server only formats
 * it. No GL is re-queried here, so there is no query-logic duplication and
 * nothing tenant-sensitive to leak — the route just needs an authenticated user.
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

  const parsed = statementModelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid statement model', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const buffer = await renderToBuffer(<StatementPdf model={parsed.data} />);
  const filename = buildExportFilename(parsed.data.title, 'pdf');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
