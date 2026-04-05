export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const periodYear = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10);
  const periodMonth = parseInt(searchParams.get('month') ?? String(new Date().getMonth() + 1), 10);

  // Get all locations
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  // Get fiscal periods for this month
  const { data: periods } = await supabase
    .from('fiscal_periods')
    .select('id, location_id, status, closed_at, closed_by')
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth);

  // Get checklist items for these periods
  const periodIds = (periods ?? []).map((p) => p.id);
  let checklistItems: { fiscal_period_id: string; location_id: string; phase: string; task_name: string; task_order: number; due_day: number; is_complete: boolean; is_auto_verified: boolean; completed_at: string | null; notes: string | null; id: string }[] = [];

  if (periodIds.length > 0) {
    const { data } = await supabase
      .from('close_checklists')
      .select('id, fiscal_period_id, location_id, phase, task_name, task_order, due_day, is_complete, is_auto_verified, completed_at, notes')
      .in('fiscal_period_id', periodIds)
      .order('task_order');
    checklistItems = (data ?? []) as typeof checklistItems;
  }

  // Build cross-entity grid
  const grid = (locations ?? []).map((loc) => {
    const period = (periods ?? []).find((p) => p.location_id === loc.id);
    const items = checklistItems.filter((c) => c.location_id === loc.id);

    const phases = {
      INITIAL: { total: 0, complete: 0, dueDay: 3 },
      MID_CLOSE: { total: 0, complete: 0, dueDay: 7 },
      FINAL: { total: 0, complete: 0, dueDay: 10 },
    };

    for (const item of items) {
      const p = phases[item.phase as keyof typeof phases];
      if (p) {
        p.total++;
        if (item.is_complete) p.complete++;
      }
    }

    return {
      locationId: loc.id,
      locationName: loc.name,
      shortCode: loc.short_code,
      periodStatus: period?.status ?? 'NO_PERIOD',
      periodId: period?.id ?? null,
      closedAt: period?.closed_at ?? null,
      phases,
      items,
      totalTasks: items.length,
      completedTasks: items.filter((i) => i.is_complete).length,
    };
  });

  // Summary
  const totalLocations = grid.length;
  const closedCount = grid.filter((g) => g.periodStatus === 'HARD_CLOSE').length;
  const inProgressCount = grid.filter((g) => g.periodStatus === 'OPEN' && g.completedTasks > 0).length;
  const notStartedCount = grid.filter((g) => g.periodStatus === 'OPEN' && g.completedTasks === 0).length;

  return NextResponse.json({
    period: { year: periodYear, month: periodMonth },
    grid,
    summary: { totalLocations, closedCount, inProgressCount, notStartedCount },
  });
}

// ─── POST: Toggle checklist item ──────────────────────────────────────
const toggleSchema = z.object({
  checklist_id: z.string().uuid(),
  is_complete: z.boolean(),
  notes: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  try {
    const raw = await request.json();
    const result = toggleSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
    }

    const body = result.data;
    const { error } = await supabase
      .from('close_checklists')
      .update({
        is_complete: body.is_complete,
        completed_by: body.is_complete ? userId : null,
        completed_at: body.is_complete ? new Date().toISOString() : null,
        notes: body.notes ?? null,
      })
      .eq('id', body.checklist_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Error' }, { status: 500 });
  }
}
