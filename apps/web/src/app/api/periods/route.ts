export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { generateYear, setPeriodStatus, type PeriodStatus } from '@/lib/services/fiscal-periods';
import { logHumanAction } from '@/lib/trust/action-log';

interface PeriodRow { id: string; location_id: string; period_year: number; period_month: number; status: PeriodStatus; closed_at: string | null }

// GET /api/periods?year=YYYY — per-company month grid for the year.
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const year = parseInt(new URL(request.url).searchParams.get('year') ?? String(new Date().getUTCFullYear()), 10);

  const { data: locations } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  const { data: periods, error } = await supabase
    .from('fiscal_periods')
    .select('id, location_id, period_year, period_month, status, closed_at')
    .eq('org_id', orgId)
    .eq('period_year', year);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byLoc = new Map<string, PeriodRow[]>();
  for (const p of (periods ?? []) as PeriodRow[]) {
    const arr = byLoc.get(p.location_id) ?? [];
    arr.push(p);
    byLoc.set(p.location_id, arr);
  }

  let gapsTotal = 0;
  const grid = (locations ?? []).map((loc) => {
    const rows = byLoc.get((loc as { id: string }).id) ?? [];
    const monthMap = new Map(rows.map((r) => [r.period_month, r]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const r = monthMap.get(m);
      if (!r) { gapsTotal++; return { month: m, status: 'NONE' as const, periodId: null, closedAt: null }; }
      return { month: m, status: r.status, periodId: r.id, closedAt: r.closed_at };
    });
    return {
      locationId: (loc as { id: string }).id,
      locationName: (loc as { name: string }).name,
      shortCode: (loc as { short_code: string }).short_code,
      months,
      generated: rows.length,
    };
  });

  return NextResponse.json({
    year,
    grid,
    summary: { companies: grid.length, gaps: gapsTotal, complete: grid.filter((g) => g.generated === 12).length },
  });
}

// POST /api/periods — generate a year for one company or all. { year, location_id?: string | 'all' }
const genSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  location_id: z.string().min(1),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = genSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 });

  const { year, location_id } = parsed.data;

  let locationIds: string[];
  if (location_id === 'all') {
    const { data: locs } = await supabase.schema('core').from('locations').select('id').eq('is_active', true);
    locationIds = (locs ?? []).map((l) => (l as { id: string }).id);
  } else {
    locationIds = [location_id];
  }

  try {
    let created = 0;
    for (const lid of locationIds) {
      const r = await generateYear(supabase, orgId, lid, year);
      created += r.created;
    }
    return NextResponse.json({ ok: true, year, companies: locationIds.length, periods_created: created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Generation failed' }, { status: 500 });
  }
}

// PATCH /api/periods — set a period's status. { period_id, status, reason? }
const statusSchema = z.object({
  period_id: z.string().uuid(),
  status: z.enum(['OPEN', 'SOFT_CLOSE', 'HARD_CLOSE']),
  reason: z.string().max(500).optional().nullable(),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId: actor } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 });

  try {
    await setPeriodStatus(supabase, orgId, parsed.data.period_id, parsed.data.status, actor, parsed.data.reason ?? null);

    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_year, period_month, location_id')
      .eq('org_id', orgId)
      .eq('id', parsed.data.period_id)
      .maybeSingle();
    const p = period as { period_year: number; period_month: number; location_id: string } | null;
    await logHumanAction(supabase, actor, orgId, {
      action: 'period.status',
      subjectTable: 'fiscal_periods',
      subjectId: parsed.data.period_id,
      summary: p
        ? `Set period ${p.period_year}/${String(p.period_month).padStart(2, '0')} to ${parsed.data.status}`
        : `Set period to ${parsed.data.status}`,
      locationId: p?.location_id ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
