export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { buildCovenantStatus, type CovenantRow } from '@/lib/covenants/status';
import { createCovenantSchema, type CreateCovenantInput } from '@/lib/covenants/schema';
import { linkSourceDocument } from '@/lib/documents/store-source';

/**
 * /api/covenants
 *
 * GET  — list every covenant with its CURRENT computed status (ratio, headroom,
 *        pass/WARN/BREACH band, projected breach date). Read-only; RLS-scoped.
 *        Degrade-safe: no covenants → empty list; a covenant whose ledger inputs
 *        aren't computable comes back band=UNKNOWN, never an error.
 * POST — define a covenant (loan/facility, type, threshold+direction, frequency,
 *        measurement definition). apiHandler enforces auth + Zod; RLS enforces org.
 */

const SELECT =
  'id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, ' +
  'test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, ' +
  'created_at, updated_at';

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const periodEnd = new URL(request.url).searchParams.get('period_end') ?? undefined;

  const { data, error } = await supabase
    .from('loan_covenants')
    .select(SELECT)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[covenants] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load covenants', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // The generated Database type omits loan_covenants, so `data` is typed
  // GenericStringError[]; restore type-safety against the local CovenantRow.
  const rows = (data ?? []) as unknown as CovenantRow[];

  // Compute status per covenant. Each is independent; one failure must not sink
  // the list, so failures degrade to a null status the UI renders as UNKNOWN.
  const statuses = await Promise.all(
    rows.map(async (row) => {
      try {
        return await buildCovenantStatus(supabase, row, periodEnd);
      } catch (e) {
        console.error('[covenants] status failed for', row.id, e instanceof Error ? e.message : e);
        return { covenant: row, error: true as const };
      }
    }),
  );

  const summary = {
    total: rows.length,
    breach: 0,
    warn: 0,
    pass: 0,
    unknown: 0,
  };
  for (const s of statuses) {
    if ('error' in s) { summary.unknown += 1; continue; }
    const band = s.evaluation.band;
    if (band === 'BREACH') summary.breach += 1;
    else if (band === 'WARN') summary.warn += 1;
    else if (band === 'PASS') summary.pass += 1;
    else summary.unknown += 1;
  }

  return NextResponse.json({ data: statuses, summary });
}

export const POST = apiHandler(
  createCovenantSchema,
  async (body: CreateCovenantInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from('loan_covenants')
      .insert({
        org_id: ctx.orgId,
        location_id: body.location_id ?? null,
        loan_name: body.loan_name,
        facility: body.facility ?? null,
        lender_name: body.lender_name ?? null,
        covenant_type: body.covenant_type,
        threshold: body.threshold,
        direction: body.direction,
        test_frequency: body.test_frequency,
        warn_headroom_pct: body.warn_headroom_pct,
        measurement: body.measurement ?? {},
        status: body.status,
        effective_date: body.effective_date ?? null,
        maturity_date: body.maturity_date ?? null,
        notes: body.notes ?? null,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[covenants] create failed:', error.message);
      return NextResponse.json({ error: error.message, code: 'CREATE_FAILED' }, { status: 500 });
    }
    const covenantId = (data as { id: string }).id;

    // Link the retained drop-and-parse source doc (if any) so it surfaces on the
    // covenant record. Best-effort — never fails the create.
    if (body.source_document_id) {
      await linkSourceDocument(ctx.supabase, body.source_document_id, 'covenant', covenantId);
    }

    return NextResponse.json({ id: covenantId }, { status: 201 });
  },
);
