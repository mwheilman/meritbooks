export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { companyJobIds, inList } from '@/lib/dealer/rpc';
import { pm } from '@/lib/pm/db';
import { EXPORT_MAX_ROWS_PER_TABLE, EXPORT_PAGE, exportFileName, exportPlan, ndjsonLine, toCsv, type ExportTable } from '@/lib/residential/export';
import { resRpc } from '@/lib/residential/rpc';
import { Uuid } from '@/lib/residential/schemas';
import { todayIso } from '@/lib/time';

const Q = z.object({
  company: Uuid,
  job: Uuid.optional(),
  format: z.enum(['ndjson', 'csv']).default('ndjson'),
  table: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
});

/**
 * Full data export (RES-127): every table the caller can read at the company (or one job), through
 * the caller's RLS client and the masked views — never more than the screens show. NDJSON streams
 * everything (one header line, then {table,row} lines); CSV is one table at a time.
 */
export const GET = route({ access: { cap: 'projects.reports', action: 'export' }, mask: false, query: Q }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const all = await resRpc<ExportTable[]>(db, 'res_export_tables', {});
  const plan = exportPlan(all, query.job ? 'job' : 'company').filter((t) => !query.table || t.source === query.table);
  if (plan.length === 0) throw new HttpError(404, 'Nothing to export for that table.', 'NOT_FOUND');
  const jobIds = query.job ? [query.job] : await companyJobIds(db, query.company);
  const company = tenant.companies.find((c) => c.id === query.company)?.name ?? 'company';

  /** ids written per table, so child tables export under their parents' rows only */
  const written = new Map<string, string[]>();
  async function rowsOf(t: ExportTable, page: number): Promise<Record<string, unknown>[]> {
    let q = pm(db).from(t.table).select('*');
    if (t.scope === 'parent' && t.parent_table && t.parent_column) {
      const parents = written.get(t.parent_table);
      if (!parents) return [];
      q = q.in(t.parent_column, inList(parents.slice(0, 5000)));
    } else if (t.class === 'J' || t.class === 'M') q = q.in('job_id', inList(jobIds));
    else if (t.class === 'C' || t.class === 'S' || t.class === 'P') q = q.eq('location_id', query.company);
    const r = await q.range(page * EXPORT_PAGE, page * EXPORT_PAGE + EXPORT_PAGE - 1);
    if (r.error) return []; // a table the caller cannot read (or that has no such scope column) is skipped, not fatal
    const rows = (r.data ?? []) as Record<string, unknown>[];
    const ids = written.get(t.source) ?? [];
    for (const row of rows) if (typeof row.id === 'string') ids.push(row.id);
    written.set(t.source, ids);
    return rows;
  }

  if (query.format === 'csv') {
    if (plan.length !== 1) throw new HttpError(422, 'Pick one table for a CSV export.', 'VALIDATION');
    if (plan[0]!.scope === 'parent') throw new HttpError(422, 'Line tables export with their parent in the full (NDJSON) export.', 'VALIDATION');
    const rows: Record<string, unknown>[] = [];
    for (let p = 0; p * EXPORT_PAGE < EXPORT_MAX_ROWS_PER_TABLE; p++) {
      const chunk = await rowsOf(plan[0]!, p);
      rows.push(...chunk);
      if (chunk.length < EXPORT_PAGE) break;
    }
    return new NextResponse(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${exportFileName('csv', `${company}-${plan[0]!.source}`, todayIso())}"` } });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(`${JSON.stringify({ export: 'merit-projects', company: query.company, job: query.job ?? null, at: new Date().toISOString(), tables: plan.map((t) => t.source) })}\n`));
      for (const t of plan) {
        for (let p = 0; p * EXPORT_PAGE < EXPORT_MAX_ROWS_PER_TABLE; p++) {
          const chunk = await rowsOf(t, p);
          for (const row of chunk) controller.enqueue(enc.encode(ndjsonLine(t.source, row)));
          if (chunk.length < EXPORT_PAGE) break;
        }
      }
      controller.close();
    },
  });
  return new NextResponse(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${exportFileName('ndjson', company, todayIso())}"` } });
});
