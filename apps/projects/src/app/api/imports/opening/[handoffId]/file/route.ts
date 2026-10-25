export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { toCsv } from '@/lib/imports/opening';
import { loadHandoff } from '@/lib/imports/server';

const Query = z.object({
  part: z.enum(['books_wip_jobs', 'job_dimension_lines', 'books_opening_rows', 'books_opening_file', 'units', 'agreements', 'customers', 'deposits', 'parts', 'claims']),
  lender: z.string().max(200).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});

/**
 * GET /api/imports/opening/:handoffId/file?part=… — the Books-ready file: Books' WIP importer jobs
 * (JSON for POST /api/onboarding/import/wip), the job-dimension opening lines, or one Dealer Pack
 * OPENING file per floor-plan lender (CSV).
 */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: Query }, async ({ db, params, query, tenant }) => {
  const h = await loadHandoff(db, params.handoffId!);
  if (!h) throw new HttpError(404, 'That opening position was not found.', 'NOT_FOUND');
  assertCompany(tenant, h.location_id);
  let rows: Record<string, unknown>[];
  if (query.part === 'books_opening_file') {
    const files = (h.payload.books_opening_files ?? []) as { lender: string | null; rows: Record<string, unknown>[] }[];
    const f = files.find((x) => (x.lender ?? '') === (query.lender ?? ''));
    if (!f) throw new HttpError(404, 'No file for that lender.', 'NOT_FOUND');
    rows = f.rows;
  } else {
    const v = h.payload[query.part];
    if (!Array.isArray(v)) throw new HttpError(404, 'This position has no such file.', 'NOT_FOUND');
    rows = (v as unknown[]).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : { value: x }));
  }
  const name = `${h.kind.toLowerCase()}-${query.part}${query.lender ? `-${query.lender.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}-${h.as_of_date}`;
  if (query.format === 'json') {
    return new NextResponse(JSON.stringify(rows, null, 2), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}.json"` } });
  }
  const flat = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])));
  return new NextResponse(toCsv(flat), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"` } });
});
