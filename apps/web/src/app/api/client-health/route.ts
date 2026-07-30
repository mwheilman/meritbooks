export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

// ── Public API shape ────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'attention' | 'behind';

export interface ClientHealth {
  locationId: string;
  name: string;
  shortCode: string;
  pendingBankTxns: number; // bank_transactions.status = 'PENDING'
  flaggedItems: number; // bank FLAGGED + receipt FLAGGED + bills ON_HOLD
  oldestUncategorizedDays: number | null; // age (days) of the oldest PENDING bank txn
  overdueBills: number; // bills.due_date < today AND status not in (PAID, VOIDED)
  status: HealthStatus;
}

export interface ClientHealthFlag {
  severity: 'high' | 'medium';
  companyName: string;
  message: string;
}

interface ClientHealthResponse {
  data: ClientHealth[];
  flags: ClientHealthFlag[];
}

// ── Internal row shapes (only the columns we select) ─────────────────────────

interface LocationRow {
  id: string;
  name: string;
  short_code: string;
}

interface LocatedRow {
  location_id: string | null;
}

interface PendingBankRow extends LocatedRow {
  created_at: string;
}

// Cap defensively — the aggregation is per-org and this dataset is 17 companies,
// so these ceilings are far above realistic backlog sizes but bound a runaway query.
const ROW_CAP = 5000;

const DAY_MS = 86_400_000;

// Status thresholds (see report): behind = oldest PENDING >= 14d OR flagged > 10.
const BEHIND_DAYS = 14;
const BEHIND_FLAGGED = 10;

function daysSince(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

function tallyByLocation(rows: LocatedRow[] | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r.location_id) continue;
    counts.set(r.location_id, (counts.get(r.location_id) ?? 0) + 1);
  }
  return counts;
}

// GET /api/client-health — per-company book-health + ranked intervention flags.
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const now = Date.now();
  const todayIso = new Date(now).toISOString().slice(0, 10);

  // Active companies (locations live in `core`; the txn tables in `public`).
  const { data: locations, error: locError } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');
  if (locError) return NextResponse.json({ error: locError.message }, { status: 500 });

  // A handful of grouped queries — aggregated in JS, never per-location N queries.
  const [pendingRes, bankFlaggedRes, receiptFlaggedRes, billsHoldRes, overdueRes] = await Promise.all([
    // Oldest first so the first row per location is that location's oldest PENDING txn.
    supabase
      .from('bank_transactions')
      .select('location_id, created_at')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true })
      .limit(ROW_CAP),
    supabase
      .from('bank_transactions')
      .select('location_id')
      .eq('status', 'FLAGGED')
      .limit(ROW_CAP),
    supabase
      .from('receipts')
      .select('location_id')
      .eq('status', 'FLAGGED')
      .limit(ROW_CAP),
    supabase
      .from('bills')
      .select('location_id')
      .eq('status', 'ON_HOLD')
      .limit(ROW_CAP),
    supabase
      .from('bills')
      .select('location_id')
      .lt('due_date', todayIso)
      .not('status', 'in', '(PAID,VOIDED)')
      .limit(ROW_CAP),
  ]);

  const firstError =
    pendingRes.error || bankFlaggedRes.error || receiptFlaggedRes.error || billsHoldRes.error || overdueRes.error;
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });

  const pendingRows = (pendingRes.data ?? []) as PendingBankRow[];
  const pendingCount = tallyByLocation(pendingRows);

  // Oldest PENDING created_at per location — rows are ascending, so first wins.
  const oldestPending = new Map<string, string>();
  for (const r of pendingRows) {
    if (r.location_id && !oldestPending.has(r.location_id)) {
      oldestPending.set(r.location_id, r.created_at);
    }
  }

  const bankFlagged = tallyByLocation(bankFlaggedRes.data as LocatedRow[] | null);
  const receiptFlagged = tallyByLocation(receiptFlaggedRes.data as LocatedRow[] | null);
  const billsHold = tallyByLocation(billsHoldRes.data as LocatedRow[] | null);
  const overdue = tallyByLocation(overdueRes.data as LocatedRow[] | null);

  const data: ClientHealth[] = ((locations ?? []) as LocationRow[]).map((loc) => {
    const pendingBankTxns = pendingCount.get(loc.id) ?? 0;
    const flaggedItems =
      (bankFlagged.get(loc.id) ?? 0) + (receiptFlagged.get(loc.id) ?? 0) + (billsHold.get(loc.id) ?? 0);
    const overdueBills = overdue.get(loc.id) ?? 0;
    const oldestIso = oldestPending.get(loc.id);
    const oldestUncategorizedDays = oldestIso ? daysSince(oldestIso, now) : null;

    let status: HealthStatus;
    if ((oldestUncategorizedDays ?? 0) >= BEHIND_DAYS || flaggedItems > BEHIND_FLAGGED) {
      status = 'behind';
    } else if (pendingBankTxns > 0 || flaggedItems > 0 || overdueBills > 0) {
      status = 'attention';
    } else {
      status = 'healthy';
    }

    return {
      locationId: loc.id,
      name: loc.name,
      shortCode: loc.short_code,
      pendingBankTxns,
      flaggedItems,
      oldestUncategorizedDays,
      overdueBills,
      status,
    };
  });

  // Worst-first: behind before attention before healthy, then by total pressure.
  const rank: Record<HealthStatus, number> = { behind: 2, attention: 1, healthy: 0 };
  const pressure = (c: ClientHealth) =>
    (c.oldestUncategorizedDays ?? 0) + c.flaggedItems * 2 + c.overdueBills * 3 + c.pendingBankTxns;
  data.sort((a, b) => rank[b.status] - rank[a.status] || pressure(b) - pressure(a));

  // Flat, ranked intervention list. Each candidate carries a sort weight.
  const candidates: Array<ClientHealthFlag & { weight: number }> = [];
  for (const c of data) {
    if ((c.oldestUncategorizedDays ?? 0) >= BEHIND_DAYS) {
      candidates.push({
        severity: 'high',
        companyName: c.name,
        message: `${c.name} is ${c.oldestUncategorizedDays} days behind on categorization`,
        weight: 1000 + (c.oldestUncategorizedDays ?? 0),
      });
    } else if (c.pendingBankTxns > 0) {
      candidates.push({
        severity: 'medium',
        companyName: c.name,
        message: `${c.name} has ${c.pendingBankTxns} uncategorized transaction${c.pendingBankTxns === 1 ? '' : 's'}`,
        weight: c.pendingBankTxns,
      });
    }

    if (c.flaggedItems > BEHIND_FLAGGED) {
      candidates.push({
        severity: 'high',
        companyName: c.name,
        message: `${c.name} has ${c.flaggedItems} flagged items needing review`,
        weight: 900 + c.flaggedItems,
      });
    } else if (c.flaggedItems > 0) {
      candidates.push({
        severity: 'medium',
        companyName: c.name,
        message: `${c.name} has ${c.flaggedItems} flagged item${c.flaggedItems === 1 ? '' : 's'} to review`,
        weight: 100 + c.flaggedItems,
      });
    }

    if (c.overdueBills > 0) {
      const high = c.overdueBills >= 5;
      candidates.push({
        severity: high ? 'high' : 'medium',
        companyName: c.name,
        message: `${c.overdueBills} overdue bill${c.overdueBills === 1 ? '' : 's'} at ${c.name}`,
        weight: (high ? 800 : 200) + c.overdueBills,
      });
    }
  }

  const severityRank = { high: 1, medium: 0 } as const;
  candidates.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.weight - a.weight);
  const flags: ClientHealthFlag[] = candidates.map(({ severity, companyName, message }) => ({
    severity,
    companyName,
    message,
  }));

  const response: ClientHealthResponse = { data, flags };
  return NextResponse.json(response);
}
