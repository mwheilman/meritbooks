export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { renderToBuffer } from '@react-pdf/renderer';
import { TaxReturnPackagePdf } from '../return-package-pdf';
import { taxReturnPackageSchema } from '@/lib/tax/return-package';
import { buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * POST /api/tax/return-package/pdf — render an assembled Tax Return Package to a branded
 * multi-page PDF. The client POSTs the SAME package it got from GET /api/tax/return-package
 * (and is previewing on screen), so the PDF ties out to what the user sees. No GL is
 * re-queried here — the route only formats — so it just needs an authenticated user.
 * Mirrors /api/reports/board-package/pdf.
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

  const parsed = taxReturnPackageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid tax return package', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const buffer = await renderToBuffer(<TaxReturnPackagePdf pkg={parsed.data} />);
  const filename = buildExportFilename(`tax-return-package-${parsed.data.meta.entityLabel}-${parsed.data.meta.taxYear}`, 'pdf');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
