export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { runPack } from '@/lib/reports/compiler/run';
import { resolveSavedPack, parseStoredSpecs } from '@/lib/reports/compiler/packs';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { buildExportFilename } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/packs/[id]/xlsx — run a SAVED pack on demand and stream ONE
 * multi-sheet .xlsx workbook. The Excel sibling of /packs/[id]/pdf: RLS-scoped, the
 * stored relative descriptors are re-expanded against the org's CURRENT fiscal
 * calendar (a pack run today reflects today's dates), and every figure comes from
 * the same ledger engines as the on-screen reports, so the workbook ties out.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });

  const { data: pack, error } = await ctx.supabase
    .from('report_packs')
    .select('name, entity_label, location_ids, specs')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  if (!pack) return NextResponse.json({ error: 'Pack not found', code: 'NOT_FOUND' }, { status: 404 });

  const row = pack as { name: string; entity_label: string | null; location_ids: string[] | null; specs: unknown };
  const specs = parseStoredSpecs(row.specs);
  if (!specs) {
    return NextResponse.json(
      { error: 'This saved pack is no longer valid and needs to be re-created.', code: 'INVALID_SPECS' },
      { status: 422 },
    );
  }

  // Fiscal-year config (RLS). Default calendar-year.
  let fyStartMonth = 1;
  try {
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('fiscal_year_start_month')
      .eq('id', ctx.orgId)
      .maybeSingle();
    const m = Number((org as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1);
    if (Number.isInteger(m) && m >= 1 && m <= 12) fyStartMonth = m;
  } catch {
    /* degrade to calendar year */
  }

  const resolved = resolveSavedPack(specs, row.entity_label, row.location_ids, fyStartMonth);

  let compiled;
  try {
    compiled = await runPack(ctx.supabase, ctx.orgId, resolved);
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
  const filename = buildExportFilename(`report-pack-${row.name}`, 'xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
