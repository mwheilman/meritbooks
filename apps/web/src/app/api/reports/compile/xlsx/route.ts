export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolvedPackSchema } from '@/lib/reports/compiler/spec';
import { runPack } from '@/lib/reports/compiler/run';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/compile/xlsx — run the CONFIRMED report specs and stream ONE
 * multi-sheet .xlsx workbook (one worksheet per report×period). The Excel sibling
 * of /compile/pdf: same runner, same RLS-scoped ledger engines, same figures — the
 * body is the resolved pack the user confirmed on screen and is RE-VALIDATED here
 * against the allowlist schema (never trust the client). Every worksheet carries a
 * metadata banner (entity/period/basis) and true numeric money cells.
 */
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const parsed = resolvedPackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid report pack', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  let compiled;
  try {
    compiled = await runPack(ctx.supabase, ctx.orgId, parsed.data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to compile report pack', code: 'COMPILE_ERROR' },
      { status: 500 },
    );
  }

  if (compiled.sections.length === 0) {
    return NextResponse.json({ error: 'The pack resolved to no report sections.', code: 'EMPTY_PACK' }, { status: 422 });
  }

  const buffer = workbookFromModels(compiled.sections.map((s) => s.model));
  const filename = buildExportFilename(`report-pack-${parsed.data.entityLabel}`, 'xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
