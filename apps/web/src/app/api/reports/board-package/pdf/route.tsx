export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { renderToBuffer } from '@react-pdf/renderer';
import { BoardPackagePdf } from '../board-package-pdf';
import { boardPackageSchema } from '@/lib/reports/board-package';
import { buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/board-package/pdf — render an assembled Board Package to a
 * branded multi-page PDF. The client POSTs the SAME BoardPackage object it got
 * from GET /api/reports/board-package (and is previewing on screen), so the PDF
 * ties out to what the user sees. No GL is re-queried here — the route only
 * formats — so there is nothing tenant-sensitive to leak; it just needs an
 * authenticated user. Mirrors /api/reports/export/pdf.
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

  const parsed = boardPackageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid board package', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const buffer = await renderToBuffer(<BoardPackagePdf pkg={parsed.data} />);
  const filename = buildExportFilename(`board-package-${parsed.data.meta.entityLabel}`, 'pdf');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
