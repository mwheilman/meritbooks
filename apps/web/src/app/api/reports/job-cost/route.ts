export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/reports/job-cost?start_date&end_date&location_ids — cross-job cost ledger.
 * Every cost posted to any job in the range, with its source (bill / bank feed /
 * manual), so a PM/controller can audit job costs across the portfolio.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const sp = new URL(request.url).searchParams;
  const start = sp.get('start_date');
  const end = sp.get('end_date');
  const locIds = sp.get('location_ids');

  let q = supabase
    .from('job_cost_entries')
    .select('id, job_id, amount_cents, entry_date, description, gl_entry_line_id, bill_line_id')
    .eq('org_id', orgId)
    .order('entry_date', { ascending: false })
    .limit(500);
  if (start) q = q.gte('entry_date', start);
  if (end) q = q.lte('entry_date', end);

  const { data: entries, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (entries ?? []) as Array<{ id: string; job_id: string; amount_cents: number; entry_date: string; description: string | null; gl_entry_line_id: string | null; bill_line_id: string | null }>;

  // Jobs (+ company), optionally filtered by location.
  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  const jobMap = new Map<string, { job_number: string; name: string; short_code: string; location_id: string }>();
  if (jobIds.length > 0) {
    const { data: jobs } = await supabase
      .schema('core').from('jobs')
      .select('id, job_number, name, location_id, location:locations!jobs_location_id_fkey(short_code)')
      .in('id', jobIds);
    for (const j of jobs ?? []) {
      jobMap.set((j as any).id, {
        job_number: (j as any).job_number,
        name: (j as any).name,
        short_code: (j as any).location?.short_code ?? '--',
        location_id: (j as any).location_id,
      });
    }
  }
  const locFilter = locIds ? new Set(locIds.split(',').filter(Boolean)) : null;

  // Source resolution (bill number / GL source module).
  const billLineIds = rows.map((r) => r.bill_line_id).filter(Boolean) as string[];
  const billByLine = new Map<string, string | null>();
  if (billLineIds.length > 0) {
    const { data: bl } = await supabase.from('bill_lines').select('id, bill_id').in('id', billLineIds);
    const billIds = [...new Set((bl ?? []).map((x) => (x as { bill_id: string }).bill_id))];
    const billNo = new Map<string, string | null>();
    if (billIds.length > 0) {
      const { data: bills } = await supabase.from('bills').select('id, bill_number').in('id', billIds);
      for (const b of bills ?? []) billNo.set((b as { id: string }).id, (b as { bill_number: string | null }).bill_number);
    }
    for (const x of bl ?? []) billByLine.set((x as { id: string }).id, billNo.get((x as { bill_id: string }).bill_id) ?? null);
  }

  const glLineIds = rows.map((r) => r.gl_entry_line_id).filter(Boolean) as string[];
  const sourceByLine = new Map<string, string>();
  if (glLineIds.length > 0) {
    const { data: glLines } = await supabase.from('gl_entry_lines').select('id, gl_entry_id').in('id', glLineIds);
    const entryIds = [...new Set((glLines ?? []).map((l) => (l as { gl_entry_id: string }).gl_entry_id))];
    const moduleById = new Map<string, string | null>();
    if (entryIds.length > 0) {
      const { data: ge } = await supabase.from('gl_entries').select('id, source_module').in('id', entryIds);
      for (const e of ge ?? []) moduleById.set((e as { id: string }).id, (e as { source_module: string | null }).source_module);
    }
    for (const l of glLines ?? []) {
      const mod = moduleById.get((l as { gl_entry_id: string }).gl_entry_id);
      if (mod) sourceByLine.set((l as { id: string }).id, mod);
    }
  }

  let totalCents = 0;
  const out = rows
    .map((r) => {
      const job = jobMap.get(r.job_id);
      if (!job) return null;
      if (locFilter && !locFilter.has(job.location_id)) return null;
      const billNumber = r.bill_line_id ? billByLine.get(r.bill_line_id) : undefined;
      const glSource = r.gl_entry_line_id ? sourceByLine.get(r.gl_entry_line_id) : undefined;
      const source = billNumber ? `Bill ${billNumber}` : glSource ? glSource.replace('_', ' ') : 'Manual';
      totalCents += Number(r.amount_cents);
      return {
        company: job.short_code,
        jobNumber: job.job_number,
        jobName: job.name,
        date: r.entry_date,
        source,
        description: r.description ?? '--',
        amountCents: Number(r.amount_cents),
      };
    })
    .filter(Boolean);

  return NextResponse.json({ data: out, totals: { entries: out.length, amountCents: totalCents } });
}
