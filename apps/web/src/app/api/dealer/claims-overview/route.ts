export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { dbFail } from '@/lib/dealer/service/errors';
import { loadSettings } from '@/lib/dealer/service/settings';
import { addDays, todayIso } from '@/lib/dealer/dates';
import {
  REJECTION_WINDOW_DAYS,
  incentiveAging,
  rejectionRates,
  warrantyAging,
  type ClaimsOverview,
} from '@/lib/dealer/ui/claims';
import type { IncentiveStatus, WarrantyStatus } from '@/lib/dealer/types';

/**
 * GET /api/dealer/claims-overview?locationId=&kind=warranty|incentive
 *
 * The warranty / incentive worklist header (slice D2-C):
 *  - status-pipeline counts (one exact HEAD count per status — cheap);
 *  - open receivable total and the DL-5 / DL-7 flags (overdue unpaid, near/past
 *    deadline) over the member-readable aging views, using the SAME pure rules the
 *    list rows use (lib/dealer/ui/claims) and the client's thresholds;
 *  - warranty only: DL-6 rejection rate per manufacturer over the last 90 days from
 *    dealer_claim_events (distinct claims rejected ÷ distinct claims submitted).
 * Read-only via the caller's RLS client, org + client pinned. → { data: ClaimsOverview }
 */
const query = z.object({
  locationId: z.string().uuid(),
  kind: z.enum(['warranty', 'incentive']),
});

const STATUSES = {
  warranty: ['DRAFT', 'SUBMITTED', 'PARTIAL', 'PAID', 'REJECTED', 'RESUBMITTED', 'WRITTEN_OFF', 'DEBITED', 'VOID'],
  incentive: ['ACCRUED', 'SUBMITTED', 'PARTIAL', 'PAID', 'REJECTED', 'WRITTEN_OFF', 'VOID'],
} as const;

export const GET = apiQueryHandler(
  query,
  dealerAction<z.infer<typeof query>>(DEALER_PERMS.view, async (b, d): Promise<ClaimsOverview> => {
    const today = todayIso();
    const table = b.kind === 'warranty' ? 'warranty_claims' : 'oem_incentive_claims';
    const statuses = STATUSES[b.kind];
    const [settings, agingRes, ...countRes] = await Promise.all([
      loadSettings(d),
      b.kind === 'warranty'
        ? d.db.from('v_warranty_aging').select('status, open_cents, submitted_date, filing_deadline').eq('org_id', d.orgId).eq('location_id', d.locationId).limit(10000)
        : d.db.from('v_incentive_aging').select('status, open_cents, submitted_date, claim_deadline').eq('org_id', d.orgId).eq('location_id', d.locationId).limit(10000),
      ...statuses.map((s) =>
        d.db.from(table).select('id', { count: 'exact', head: true }).eq('org_id', d.orgId).eq('location_id', d.locationId).eq('status', s),
      ),
    ]);
    const counts: Record<string, number> = {};
    let total = 0;
    countRes.forEach((r, i) => {
      if (r.error) dbFail('Claim counts failed', r.error);
      counts[statuses[i]] = r.count ?? 0;
      total += r.count ?? 0;
    });
    if (agingRes.error) dbFail('Claim aging lookup failed', agingRes.error);

    let openCents = 0;
    let openCount = 0;
    const overdue = { count: 0, cents: 0 };
    const deadline = { count: 0, cents: 0 };
    for (const raw of (agingRes.data ?? []) as Record<string, unknown>[]) {
      const open = Number(raw.open_cents ?? 0);
      const status = raw.status as string;
      const flag =
        b.kind === 'warranty'
          ? warrantyAging({ status: status as WarrantyStatus, filing_deadline: (raw.filing_deadline as string | null) ?? null, submitted_date: (raw.submitted_date as string | null) ?? null }, settings, today).flag
          : incentiveAging({ status: status as IncentiveStatus, claim_deadline: (raw.claim_deadline as string | null) ?? null, submitted_date: (raw.submitted_date as string | null) ?? null }, settings, today).flag;
      // Drafts aren't receivables yet; count them only toward the deadline flag.
      if (!(b.kind === 'warranty' && status === 'DRAFT')) {
        openCents += open;
        openCount += 1;
      }
      if (!flag) continue;
      const bucket = flag.tone === 'danger' ? deadline : overdue;
      bucket.count += 1;
      bucket.cents += open;
    }

    if (b.kind !== 'warranty') return { counts, total, openCents, openCount, overdue, deadline, rejection: [] };

    const since = addDays(today, -REJECTION_WINDOW_DAYS);
    const ev = await d.db
      .from('dealer_claim_events')
      .select('warranty_claim_id, event_type')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .eq('claim_kind', 'WARRANTY')
      .in('event_type', ['SUBMITTED', 'RESUBMITTED', 'REJECTED'])
      .gte('event_date', since)
      .limit(5000);
    if (ev.error) dbFail('Claim events lookup failed', ev.error);
    const events = (ev.data ?? []) as { warranty_claim_id: string | null; event_type: string }[];
    const ids = [...new Set(events.map((e) => e.warranty_claim_id).filter((x): x is string => !!x))];
    const oemOf = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const c = await d.db.from('warranty_claims').select('id, oem_vendor_id').eq('org_id', d.orgId).eq('location_id', d.locationId).in('id', chunk);
      if (c.error) dbFail('Warranty claim lookup failed', c.error);
      for (const row of (c.data ?? []) as { id: string; oem_vendor_id: string }[]) oemOf.set(row.id, row.oem_vendor_id);
    }
    const rejection = rejectionRates(
      events
        .filter((e) => e.warranty_claim_id && oemOf.has(e.warranty_claim_id))
        .map((e) => ({ claimId: e.warranty_claim_id as string, oemVendorId: oemOf.get(e.warranty_claim_id as string) as string, type: e.event_type })),
    );
    return { counts, total, openCents, openCount, overdue, deadline, rejection };
  }),
);
