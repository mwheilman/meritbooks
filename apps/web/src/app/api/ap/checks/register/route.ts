export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { registerQuery } from '@/lib/validations/checks';
import { loadRegister, registerCsv } from '@/lib/ap/checks/register-service';
import { checkErrorResponse, requireCheckView, userNames } from '@/lib/ap/checks/route-support';

/**
 * GET /api/ap/checks/register — the check register for one bank account: filtered, sorted,
 * paginated rows + the outstanding / cleared / stale / gap summary. `format=csv` exports
 * every row matching the filter. checks:view; RLS + client scope via the caller's client.
 */
export const GET = apiQueryHandler(registerQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    const csv = q.format === 'csv';
    const reg = await loadRegister(supabase, orgId, q.bank_account_id, {
      filter: q.filter, q: q.q, from: q.from, to: q.to, sort: q.sort, dir: q.dir,
      page: csv ? 1 : q.page, pageSize: csv ? 500 : q.page_size,
    });
    if (csv) {
      let rows = reg.rows;
      for (let page = 2; rows.length < reg.total; page++) {
        const more = await loadRegister(supabase, orgId, q.bank_account_id, { filter: q.filter, q: q.q, from: q.from, to: q.to, sort: q.sort, dir: q.dir, page, pageSize: 500 });
        if (more.rows.length === 0) break;
        rows = rows.concat(more.rows);
      }
      return new NextResponse(registerCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="check-register-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    const names = await userNames(supabase, reg.rows.map((r) => r.printedBy));
    return NextResponse.json({ ...reg, names });
  } catch (e) {
    return checkErrorResponse(e, 'Could not load the check register.');
  }
});
