export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('recurring_templates')
    .select(`
      id, name, description, frequency, start_date, end_date,
      next_run_date, is_reversing, is_active, template_lines,
      last_generated_at, created_at,
      location:locations!recurring_templates_location_id_fkey(id, name, short_code)
    `)
    .order('next_run_date', { ascending: true, nullsFirst: false });

  if (error) {
    console.error('[recurring] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const templates = (data ?? []).map((t: Record<string, unknown>) => ({
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
