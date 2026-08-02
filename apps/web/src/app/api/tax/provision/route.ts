export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler, apiHandler } from '@/lib/api-handler';
import {
  computeProvisionForPeriod,
  proposeProvision,
  postProvision,
} from '@/lib/tax/provision-service';

/**
 * Income Tax Provision (ASC 740).
 *
 *   GET  /api/tax/provision  — compute current + deferred tax for a period from live GL
 *                              activity (book NI + the M-1 permanent/temporary split). Read-only;
 *                              returns any saved provision row for the same period too.
 *   POST /api/tax/provision  — { action: 'propose' } snapshots the computed provision PROPOSED;
 *                              { action: 'post', provision_id } posts the balanced provision JE
 *                              (income tax expense / income taxes payable + deferred tax
 *                              asset/liability) through the deterministic engine, source_ref
 *                              guarded against a double post.
 *
 * RLS scopes everything to the caller's org. Compute never posts or moves money.
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  start_date: z.string().regex(dateRe).optional(),
  end_date: z.string().regex(dateRe).optional(),
  statutory_rate: z.coerce.number().min(0).max(100).optional(),
  location_id: z.string().optional(),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }
  const now = new Date();
  const startDate = params.start_date ?? `${now.getFullYear()}-01-01`;
  const endDate = params.end_date ?? `${now.getFullYear()}-12-31`;
  const statutoryRatePct = params.statutory_rate ?? 21;
  const locationId = params.location_id && params.location_id !== 'all' ? params.location_id : null;

  const computation = await computeProvisionForPeriod(ctx.supabase, ctx.orgId, {
    startDate,
    endDate,
    statutoryRatePct,
    locationId,
  });

  // Surface any already-saved provision for this exact period/entity.
  let saved = null;
  {
    const q = ctx.supabase
      .from('tax_provision')
      .select('id, status, gl_entry_id, source_ref, statutory_rate, posted_at, total_provision_cents')
      .eq('org_id', ctx.orgId)
      .eq('start_date', startDate)
      .eq('end_date', endDate);
    const scoped = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
    const { data } = await scoped.limit(1).maybeSingle();
    saved = data ?? null;
  }

  return NextResponse.json({ data: { ...computation, saved } });
});

const postSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('propose'),
    start_date: z.string().regex(dateRe),
    end_date: z.string().regex(dateRe),
    statutory_rate: z.number().min(0).max(100),
    location_id: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal('post'),
    provision_id: z.string().uuid(),
  }),
]);

export const POST = apiHandler(postSchema, async (body, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  try {
    if (body.action === 'propose') {
      const { provision, computation } = await proposeProvision(
        ctx.supabase,
        ctx.orgId,
        {
          startDate: body.start_date,
          endDate: body.end_date,
          statutoryRatePct: body.statutory_rate,
          locationId: body.location_id ?? null,
        },
        ctx.userId ?? null,
      );
      return NextResponse.json({ data: { provision, computation } });
    }

    const result = await postProvision(ctx.supabase, ctx.orgId, body.provision_id, ctx.userId ?? null);
    return NextResponse.json({ data: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Provision operation failed', code: 'PROVISION_ERROR' },
      { status: 400 },
    );
  }
});
