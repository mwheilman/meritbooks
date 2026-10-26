/**
 * The owner's view of the Projects seam, Books side (migration 194): what came in from Merit
 * Projects, what Books did with it, and what needs a person. RLS-scoped reads (the caller's
 * client) for everything a member may read; feeds /jobs/projects-seam and the close task's
 * deep link.
 *
 * Security review H1: the per-person labor columns of job_labor_hours (employee_id,
 * standard_rate_cents, allocated_cents, accrued_cents) are column-revoked for members
 * (194 §99, comp field class). The labor tiles need only per-company AGGREGATES of them
 * (open accrual, entries with no Books employee), so those are read through the service role,
 * pinned to the org and to the companies the caller can see through RLS (client scope) — the
 * per-person rows never leave the server.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasModule } from '@/lib/services/entitlements';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { serviceWriter } from '@/lib/db/scoped-writer';

type DB = SupabaseClient;

export interface SeamStatus {
  projectsEnabled: boolean;
  events: Array<{ eventType: string; pending: number; rejected: number; processed: number; oldestPendingAt: string | null }>;
  rejected: Array<{ id: string; eventType: string; errorCode: string | null; error: string | null; occurredOn: string; jobId: string | null }>;
  commitments: { active: number; retired: number; onHold: number; committedCents: number; matchedCents: number };
  billsOnCommitmentHold: Array<{ billId: string; billNumber: string | null; reason: string | null; totalCents: number }>;
  threeWayWarnings: Array<{ billId: string; billLineId: string; status: string; varianceCents: number; commitmentNumber: string | null }>;
  labor: {
    hoursAwaitingPayroll: number;
    entriesAwaitingPayroll: number;
    entriesWithoutEmployee: number;
    withdrawnAfterPayroll: number;
    accruedOpenCents: number;
    allocations: Array<{ id: string; payrollRunId: string; periodStart: string; periodEnd: string; status: string; allocatedCents: number; unallocatedCostCents: number; unallocatedHours: number; error: string | null }>;
  };
  accrualSettings: Array<{ locationId: string; accrueStandardRate: boolean }>;
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export interface LoadSeamStatusOptions {
  locationId?: string | null;
  /** Service-role client for the per-company labor aggregates (tests inject one). */
  service?: DB | null;
}

export async function loadSeamStatus(db: DB, orgId: string, opts: LoadSeamStatusOptions = {}): Promise<SeamStatus> {
  const projectsEnabled = await hasModule(db, orgId, 'projects').catch(() => false);
  const empty: SeamStatus = {
    projectsEnabled,
    events: [],
    rejected: [],
    commitments: { active: 0, retired: 0, onHold: 0, committedCents: 0, matchedCents: 0 },
    billsOnCommitmentHold: [],
    threeWayWarnings: [],
    labor: { hoursAwaitingPayroll: 0, entriesAwaitingPayroll: 0, entriesWithoutEmployee: 0, withdrawnAfterPayroll: 0, accruedOpenCents: 0, allocations: [] },
    accrualSettings: [],
  };
  if (!projectsEnabled) return empty;
  const loc = opts.locationId ?? null;
  // Companies in view: every company the caller can read (RLS + client scope), narrowed to the
  // one asked for. The visible set is what pins the service-role labor aggregate below.
  const { data: visible } = await db.schema('core').from('locations').select('id').eq('org_id', orgId);
  const visibleIds = ((visible ?? []) as { id: string }[]).map((l) => l.id);
  const locs = loc ? visibleIds.filter((id) => id === loc) : visibleIds;
  if (locs.length === 0) return empty;

  const [eventsRes, commitsRes, linesRes, matchesRes, hoursRes, allocRes, settingsRes] = await Promise.all([
    fetchAll(
      () => db.schema('core').from('events').select('id, event_type, status, created_at, occurred_on, error, error_code, payload')
        .eq('org_id', orgId).in('source_module', ['PROJECTS', 'projects']).in('status', ['pending', 'rejected']),
      { label: 'seam status open events' },
    ),
    fetchAll(() => db.from('ap_commitments').select('id, number, active, payment_hold').eq('org_id', orgId).in('location_id', locs), { label: 'seam status commitments' }),
    fetchAll(() => db.from('ap_commitment_lines').select('id, commitment_id, amount_cents, removed').eq('org_id', orgId).in('location_id', locs), { label: 'seam status commitment lines' }),
    fetchAll(() => db.from('bill_commitment_matches').select('id, bill_id, bill_line_id, commitment_id, amount_cents, three_way_status, variance_cents, held_by_commitment').eq('org_id', orgId).in('location_id', locs), { label: 'seam status matches' }),
    // H1: aggregate-only read of per-person columns, service role, pinned to org + visible companies.
    fetchAll(() => serviceWriter(opts.service).from('job_labor_hours').select('id, hours, status, allocation_id, employee_id, accrued_cents').eq('org_id', orgId).in('location_id', locs), { label: 'seam status hours' }),
    db.from('job_labor_allocations').select('id, payroll_run_id, period_start, period_end, status, allocated_cents, unallocated_cost_cents, unallocated_hours, error').eq('org_id', orgId).in('location_id', locs)
      .order('period_end', { ascending: false }).limit(12),
    db.from('job_labor_settings').select('location_id, accrue_standard_rate').eq('org_id', orgId).in('location_id', locs),
  ]);

  type Ev = { id: string; event_type: string; status: string; created_at: string; occurred_on: string; error: string | null; error_code: string | null; payload: Record<string, unknown> | null };
  const evs = ((eventsRes.data ?? []) as Ev[]).filter((e) => !loc || !e.payload?.location_id || e.payload.location_id === loc);
  const byType = new Map<string, { pending: number; rejected: number; processed: number; oldestPendingAt: string | null }>();
  for (const e of evs) {
    const t = byType.get(e.event_type) ?? { pending: 0, rejected: 0, processed: 0, oldestPendingAt: null };
    if (e.status === 'pending') {
      t.pending++;
      if (!t.oldestPendingAt || e.created_at < t.oldestPendingAt) t.oldestPendingAt = e.created_at;
    } else t.rejected++;
    byType.set(e.event_type, t);
  }

  const commits = (commitsRes.data ?? []) as { id: string; number: string; active: boolean; payment_hold: boolean }[];
  const numberOf = new Map(commits.map((c) => [c.id, c.number]));
  const lines = (linesRes.data ?? []) as { id: string; commitment_id: string; amount_cents: number | string; removed: boolean }[];
  const activeIds = new Set(commits.filter((c) => c.active).map((c) => c.id));
  const matches = (matchesRes.data ?? []) as { id: string; bill_id: string; bill_line_id: string; commitment_id: string; amount_cents: number | string; three_way_status: string; variance_cents: number | string; held_by_commitment: boolean }[];

  const heldBillIds = [...new Set(matches.filter((m) => m.held_by_commitment).map((m) => m.bill_id))];
  let billsOnHold: SeamStatus['billsOnCommitmentHold'] = [];
  if (heldBillIds.length > 0) {
    const { data } = await db.from('bills').select('id, bill_number, payment_hold_reason, total_cents, status').eq('org_id', orgId).in('id', heldBillIds).eq('status', 'ON_HOLD');
    billsOnHold = ((data ?? []) as { id: string; bill_number: string | null; payment_hold_reason: string | null; total_cents: number | string }[])
      .map((b) => ({ billId: b.id, billNumber: b.bill_number, reason: b.payment_hold_reason, totalCents: n(b.total_cents) }));
  }

  const hours = (hoursRes.data ?? []) as { id: string; hours: number | string; status: string; allocation_id: string | null; employee_id: string | null; accrued_cents: number | string }[];
  const awaiting = hours.filter((h) => h.status === 'APPROVED' && !h.allocation_id);

  return {
    projectsEnabled,
    events: [...byType.entries()].map(([eventType, v]) => ({ eventType, ...v })).sort((a, b) => a.eventType.localeCompare(b.eventType)),
    rejected: evs.filter((e) => e.status === 'rejected').slice(0, 50).map((e) => ({
      id: e.id, eventType: e.event_type, errorCode: e.error_code, error: e.error, occurredOn: e.occurred_on,
      jobId: e.payload?.job_id ? String(e.payload.job_id) : null,
    })),
    commitments: {
      active: activeIds.size,
      retired: commits.length - activeIds.size,
      onHold: commits.filter((c) => c.active && c.payment_hold).length,
      committedCents: lines.filter((l) => !l.removed && activeIds.has(l.commitment_id)).reduce((s, l) => s + n(l.amount_cents), 0),
      matchedCents: matches.reduce((s, m) => s + n(m.amount_cents), 0),
    },
    billsOnCommitmentHold: billsOnHold,
    threeWayWarnings: matches.filter((m) => m.three_way_status !== 'OK').slice(0, 50).map((m) => ({
      billId: m.bill_id, billLineId: m.bill_line_id, status: m.three_way_status, varianceCents: n(m.variance_cents), commitmentNumber: numberOf.get(m.commitment_id) ?? null,
    })),
    labor: {
      hoursAwaitingPayroll: Math.round(awaiting.reduce((s, h) => s + n(h.hours) * 100, 0)) / 100,
      entriesAwaitingPayroll: awaiting.length,
      entriesWithoutEmployee: awaiting.filter((h) => !h.employee_id).length,
      withdrawnAfterPayroll: hours.filter((h) => h.status === 'WITHDRAWN' && h.allocation_id).length,
      accruedOpenCents: awaiting.reduce((s, h) => s + n(h.accrued_cents), 0),
      allocations: ((allocRes.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
        id: String(a.id), payrollRunId: String(a.payroll_run_id), periodStart: String(a.period_start), periodEnd: String(a.period_end),
        status: String(a.status), allocatedCents: n(a.allocated_cents), unallocatedCostCents: n(a.unallocated_cost_cents),
        unallocatedHours: n(a.unallocated_hours), error: (a.error as string | null) ?? null,
      })),
    },
    accrualSettings: ((settingsRes.data ?? []) as { location_id: string; accrue_standard_rate: boolean }[]).map((s) => ({ locationId: s.location_id, accrueStandardRate: s.accrue_standard_rate })),
  };
}
