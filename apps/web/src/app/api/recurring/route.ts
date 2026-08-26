export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data, error } = await supabase
    .from('recurring_templates')
    .select(`
      id, name, description, frequency, start_date, end_date,
      next_run_date, is_reversing, is_active, template_lines,
      last_generated_at, created_at,
      location_id
    `)
    .eq('org_id', orgId)
    .order('next_run_date', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('[recurring] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Record<string, any>>;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', rows.map((r) => r.location_id));
  for (const r of rows) r.location = r.location_id ? locMap.get(r.location_id) ?? null : null;

  const templates = rows.map((t: Record<string, unknown>) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    frequency: t.frequency,
    startDate: t.start_date,
    endDate: t.end_date,
    nextRunDate: t.next_run_date,
    isReversing: t.is_reversing,
    isActive: t.is_active,
    lineCount: Array.isArray(t.template_lines) ? (t.template_lines as unknown[]).length : 0,
    lastGeneratedAt: t.last_generated_at,
    createdAt: t.created_at,
    location: t.location,
  }));

  const activeCount = templates.filter((t: Record<string, unknown>) => t.isActive).length;
  const now = new Date().toISOString().split('T')[0];
  const dueCount = templates.filter((t: Record<string, unknown>) => t.isActive && t.nextRunDate && (t.nextRunDate as string) <= now).length;

  return NextResponse.json({
    data: templates,
    summary: { total: templates.length, active: activeCount, dueNow: dueCount },
  });
}
