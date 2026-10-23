export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { dashboardQuery } from '@/lib/validations/vendor-compliance';
import { buildDashboard } from '@/lib/vendor-compliance/dashboard';
import { VENDOR_TYPE_LABEL } from '@/lib/vendor-compliance/requirements';
import { noOrg, vcView } from '@/lib/vendor-compliance/route-auth';

function cell(v: string | number | boolean | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  // CSV + spreadsheet-formula injection safe.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const centsToPlain = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

/** GET /api/vendor-compliance/export?location_id= — the dashboard as CSV (RLS read). compliance:view. */
export const GET = apiQueryHandler(dashboardQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/export');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const d = await buildDashboard(supabase, orgId, { locationId: q.location_id ?? null });
  const head = ['Vendor', 'Email', 'Type', 'Companies', 'Requirement set', 'Compliant', 'On hold', 'Missing', 'Expiring within 30 days', 'Waiting for review', 'Bank change pending', 'Next expiry', 'Open A/P', 'Status', 'Requirements'];
  const lines = [head.map(cell).join(',')];
  for (const r of d.rows) {
    lines.push(
      [
        r.vendorName,
        r.email,
        r.vendorType ? VENDOR_TYPE_LABEL[r.vendorType] : '',
        r.companies.map((c) => c.name).join('; '),
        r.requirementSet?.name ?? 'Tracked documents',
        r.compliant ? 'Yes' : 'No',
        r.onHold ? 'Yes' : 'No',
        r.missing ? 'Yes' : 'No',
        r.expiring ? 'Yes' : 'No',
        r.pendingReview,
        r.bankChangePending ? 'Yes' : 'No',
        r.nextExpiry,
        centsToPlain(r.openBillsCents),
        r.headline,
        r.rules.map((x) => `${x.label}: ${x.reason}`).join(' | '),
      ].map(cell).join(','),
    );
  }
  const stamp = d.asOf.slice(0, 10);
  return new NextResponse(`${lines.join('\r\n')}\r\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vendor-compliance-${stamp}.csv"`, 'Cache-Control': 'no-store' },
  });
});
