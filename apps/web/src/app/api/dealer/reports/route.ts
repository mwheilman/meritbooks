export const dynamic = 'force-dynamic';

import type { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { dealerReportQuery } from '@/lib/validations/dealer-d2';
import { loadDealerReport } from '@/lib/dealer/reports/load';

/**
 * GET /api/dealer/reports?locationId=&report=<key>&start=&end=&asOf=
 * Dealer reports R1–R8 (FPB-dealer-pack §7), read through the caller's RLS client.
 * → { data: { report: DealerReport, model: StatementModel } } — `model` is the
 * reports system's export interchange (PDF / CSV / XLSX).
 */
export const GET = apiQueryHandler(
  dealerReportQuery,
  dealerAction<z.infer<typeof dealerReportQuery>>(DEALER_PERMS.view, async (q, d) =>
    loadDealerReport(d, q.report, { start: q.start, end: q.end, asOf: q.asOf }),
  ),
);
