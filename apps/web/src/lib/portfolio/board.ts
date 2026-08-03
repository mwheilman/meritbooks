/**
 * Portfolio plane — the cross-entity operator board (F5, the white-label moat).
 *
 * One screen across ALL of a tenant's companies (core.locations). For a
 * multi-entity operator or an accounting practice, this is the "how are all my
 * books doing right now" view: per-company close status, cash, open exceptions,
 * overdue AR/AP, and a red/amber/green roll-up.
 *
 * It REUSES existing per-entity engines rather than recomputing anything:
 *   • close status + open exceptions ... `gatherCloseOrchestration`
 *     (lib/close/readiness) — the same signal set the Close Command Center scores.
 *   • cash position ..................... `bank_accounts.current_balance_cents`
 *     grouped by location + `core.locations.minimum_cash_cents` banding — the same
 *     source + banding as /api/cash.
 *   • overdue AR / AP ................... `v_ar_aging` / `v_ap_aging` balances where
 *     `aging_bucket <> 'CURRENT'`.
 *   • ownership assignments ............. `core.practice_assignments` (RESERVED
 *     migration — DEGRADE-SAFE: absent ⇒ everyone unassigned, board still works).
 *
 * Everything runs through the RLS-scoped client, so tenant isolation is enforced
 * by the database. All money is bigint cents. Locations are the tenant's
 * companies/entities — nothing tenant-specific is hardcoded.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gatherCloseOrchestration, type BoardPeriodStatus } from '@/lib/close/readiness';

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const ROW_CAP = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The four functions an operator assigns per entity. */
export const PORTFOLIO_FUNCTIONS = ['close', 'ar', 'ap', 'review'] as const;
export type PortfolioFunction = (typeof PORTFOLIO_FUNCTIONS)[number];

export type CashStatus = 'HEALTHY' | 'ADEQUATE' | 'NEAR_MINIMUM' | 'CRITICAL';
export type Rag = 'green' | 'amber' | 'red';

export interface PortfolioAssignee {
  employeeId: string;
  name: string;
}

export interface PortfolioEntity {
  locationId: string;
  name: string;
  shortCode: string;
  // Close
  periodStatus: BoardPeriodStatus;
  periodId: string | null;
  readyToClose: boolean;
  closeBlockers: number;
  closedAt: string | null;
  // Cash
  cashCents: number;
  minimumCashCents: number;
  cashStatus: CashStatus;
  // Work
  openExceptions: number;
  overdueArCents: number;
  overdueApCents: number;
  // Roll-up
  rag: Rag;
  concerns: string[];
  // Ownership (degrade-safe — empty when the table is absent)
  assignments: Partial<Record<PortfolioFunction, PortfolioAssignee>>;
}

export interface PortfolioTotals {
  entities: number;
  cashCents: number;
  overdueArCents: number;
  overdueApCents: number;
  openExceptions: number;
  red: number;
  amber: number;
  green: number;
  readyToClose: number;
  blocked: number;
  closed: number;
}

export interface PortfolioBoard {
  period: { year: number; month: number; label: string };
  generatedAt: string;
  totals: PortfolioTotals;
  entities: PortfolioEntity[];
  /** false when core.practice_assignments is not present yet (degrade-safe). */
  assignmentsAvailable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash banding — mirrors the v_cash_position view / /api/cash thresholds
// ─────────────────────────────────────────────────────────────────────────────

function cashStatus(totalCents: number, minimumCents: number): CashStatus {
  if (minimumCents <= 0) return 'ADEQUATE';
  if (totalCents >= minimumCents * 2) return 'HEALTHY';
  if (totalCents >= minimumCents) return 'ADEQUATE';
  if (totalCents >= minimumCents * 0.5) return 'NEAR_MINIMUM';
  return 'CRITICAL';
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership assignments (degrade-safe)
// ─────────────────────────────────────────────────────────────────────────────

interface AssignmentRow {
  location_id: string;
  function: string;
  assignee_employee_id: string | null;
}

export interface AssignmentsLoad {
  available: boolean;
  /** location_id → function → employeeId */
  byLocation: Map<string, Map<PortfolioFunction, string>>;
}

const isFunction = (v: string): v is PortfolioFunction =>
  (PORTFOLIO_FUNCTIONS as readonly string[]).includes(v);

/**
 * Load practice assignments. DEGRADE-SAFE: if the (RESERVED) table is not present
 * yet, `available` is false and the map is empty — callers show everyone
 * unassigned and the board still renders.
 */
export async function loadAssignments(supabase: SupabaseClient): Promise<AssignmentsLoad> {
  const byLocation = new Map<string, Map<PortfolioFunction, string>>();
  const { data, error } = await supabase
    .schema('core')
    .from('practice_assignments')
    .select('location_id, function, assignee_employee_id')
    .limit(ROW_CAP);

  if (error) {
    // 42P01 = undefined_table. Any read error ⇒ degrade to "unavailable".
    return { available: false, byLocation };
  }
  for (const r of (data ?? []) as AssignmentRow[]) {
    if (!r.location_id || !r.assignee_employee_id || !isFunction(r.function)) continue;
    const fns = byLocation.get(r.location_id) ?? new Map<PortfolioFunction, string>();
    fns.set(r.function, r.assignee_employee_id);
    byLocation.set(r.location_id, fns);
  }
  return { available: true, byLocation };
}

/** Active employees for the org (assignee roster + name resolution). */
export async function loadEmployeeNames(
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { data } = await supabase
    .schema('core')
    .from('employees')
    .select('id, first_name, last_name, is_active')
    .eq('is_active', true)
    .limit(ROW_CAP);
  for (const e of (data ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
  }>) {
    names.set(e.id, `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Unnamed');
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash + overdue AR/AP roll-ups
// ─────────────────────────────────────────────────────────────────────────────

async function loadCashByLocation(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  const byLoc = new Map<string, number>();
  const { data } = await supabase
    .from('bank_accounts')
    .select('location_id, current_balance_cents')
    .eq('is_active', true)
    .limit(ROW_CAP);
  for (const r of (data ?? []) as Array<{
    location_id: string | null;
    current_balance_cents: number | string | null;
  }>) {
    if (!r.location_id) continue;
    byLoc.set(r.location_id, (byLoc.get(r.location_id) ?? 0) + num(r.current_balance_cents));
  }
  return byLoc;
}

/** Sum of balances past due (aging bucket other than CURRENT) per location. */
async function loadOverdueByLocation(
  supabase: SupabaseClient,
  view: 'v_ar_aging' | 'v_ap_aging',
): Promise<Map<string, number>> {
  const byLoc = new Map<string, number>();
  const { data } = await supabase
    .from(view)
    .select('location_id, balance_cents, aging_bucket')
    .neq('aging_bucket', 'CURRENT')
    .limit(ROW_CAP);
  for (const r of (data ?? []) as Array<{
    location_id: string | null;
    balance_cents: number | string | null;
    aging_bucket: string;
  }>) {
    if (!r.location_id) continue;
    byLoc.set(r.location_id, (byLoc.get(r.location_id) ?? 0) + num(r.balance_cents));
  }
  return byLoc;
}

async function loadMinimumCash(supabase: SupabaseClient): Promise<Map<string, number>> {
  const byLoc = new Map<string, number>();
  const { data } = await supabase
    .schema('core')
    .from('locations')
    .select('id, minimum_cash_cents')
    .eq('is_active', true)
    .limit(ROW_CAP);
  for (const r of (data ?? []) as Array<{ id: string; minimum_cash_cents: number | string | null }>) {
    byLoc.set(r.id, num(r.minimum_cash_cents));
  }
  return byLoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roll-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic red/amber/green roll-up from the per-entity signals, with a
 * human-readable concern list. RED is reserved for things that need action now
 * (cash below floor, an exception pile-up); AMBER surfaces watch items.
 */
function rollUp(e: {
  periodStatus: BoardPeriodStatus;
  readyToClose: boolean;
  closeBlockers: number;
  cashStatus: CashStatus;
  openExceptions: number;
  overdueArCents: number;
  overdueApCents: number;
}): { rag: Rag; concerns: string[] } {
  const concerns: string[] = [];
  const closeOpen = e.periodStatus === 'OPEN' || e.periodStatus === 'SOFT_CLOSE';

  if (e.cashStatus === 'CRITICAL') concerns.push('Cash below minimum');
  else if (e.cashStatus === 'NEAR_MINIMUM') concerns.push('Cash near minimum');

  if (closeOpen && !e.readyToClose && e.closeBlockers > 0) {
    concerns.push(`${e.closeBlockers} close blocker${e.closeBlockers === 1 ? '' : 's'}`);
  }
  if (e.openExceptions > 0) {
    concerns.push(`${e.openExceptions} open exception${e.openExceptions === 1 ? '' : 's'}`);
  }
  if (e.overdueArCents > 0) concerns.push('Overdue AR');
  if (e.overdueApCents > 0) concerns.push('Overdue AP');

  const red = e.cashStatus === 'CRITICAL' || e.openExceptions >= 5;
  const amber =
    e.cashStatus === 'NEAR_MINIMUM' ||
    (closeOpen && !e.readyToClose && e.closeBlockers > 0) ||
    e.openExceptions > 0 ||
    e.overdueArCents > 0 ||
    e.overdueApCents > 0;

  const rag: Rag = red ? 'red' : amber ? 'amber' : 'green';
  return { rag, concerns };
}

// ─────────────────────────────────────────────────────────────────────────────
// Board assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the portfolio board for a fiscal month across all active entities.
 * Read-only. Reuses `gatherCloseOrchestration` for close + exceptions, and joins
 * cash / overdue AR / overdue AP / ownership on top.
 */
export async function gatherPortfolioBoard(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<PortfolioBoard> {
  const now = new Date();
  const label = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const [close, cashByLoc, minCashByLoc, overdueAr, overdueAp, assignments, empNames] =
    await Promise.all([
      gatherCloseOrchestration(supabase, orgId, year, month),
      loadCashByLocation(supabase),
      loadMinimumCash(supabase),
      loadOverdueByLocation(supabase, 'v_ar_aging'),
      loadOverdueByLocation(supabase, 'v_ap_aging'),
      loadAssignments(supabase),
      loadEmployeeNames(supabase),
    ]);

  const entities: PortfolioEntity[] = close.entities.map((c) => {
    const cashCents = cashByLoc.get(c.locationId) ?? 0;
    const minimumCashCents = minCashByLoc.get(c.locationId) ?? 0;
    const cash = cashStatus(cashCents, minimumCashCents);
    const overdueArCents = overdueAr.get(c.locationId) ?? 0;
    const overdueApCents = overdueAp.get(c.locationId) ?? 0;
    const openExceptions = c.signals.openExceptions;
    const closeBlockers = c.evaluation.blockers.length;

    const { rag, concerns } = rollUp({
      periodStatus: c.periodStatus,
      readyToClose: c.evaluation.readyToHardClose,
      closeBlockers,
      cashStatus: cash,
      openExceptions,
      overdueArCents,
      overdueApCents,
    });

    // Resolve ownership (degrade-safe).
    const assignMap = assignments.byLocation.get(c.locationId);
    const resolved: Partial<Record<PortfolioFunction, PortfolioAssignee>> = {};
    if (assignMap) {
      for (const fn of PORTFOLIO_FUNCTIONS) {
        const empId = assignMap.get(fn);
        if (empId) {
          resolved[fn] = { employeeId: empId, name: empNames.get(empId) ?? 'Unknown' };
        }
      }
    }

    return {
      locationId: c.locationId,
      name: c.name,
      shortCode: c.shortCode,
      periodStatus: c.periodStatus,
      periodId: c.periodId,
      readyToClose: c.evaluation.readyToHardClose,
      closeBlockers,
      closedAt: c.closedAt,
      cashCents,
      minimumCashCents,
      cashStatus: cash,
      openExceptions,
      overdueArCents,
      overdueApCents,
      rag,
      concerns,
      assignments: resolved,
    };
  });

  // Worst-first default: red → amber → green, then by dollar pressure.
  const ragRank: Record<Rag, number> = { red: 2, amber: 1, green: 0 };
  const pressure = (e: PortfolioEntity) =>
    e.openExceptions * 3 + (e.cashStatus === 'CRITICAL' ? 100 : 0) + e.closeBlockers;
  entities.sort((a, b) => ragRank[b.rag] - ragRank[a.rag] || pressure(b) - pressure(a));

  const totals: PortfolioTotals = {
    entities: entities.length,
    cashCents: entities.reduce((s, e) => s + e.cashCents, 0),
    overdueArCents: entities.reduce((s, e) => s + e.overdueArCents, 0),
    overdueApCents: entities.reduce((s, e) => s + e.overdueApCents, 0),
    openExceptions: entities.reduce((s, e) => s + e.openExceptions, 0),
    red: entities.filter((e) => e.rag === 'red').length,
    amber: entities.filter((e) => e.rag === 'amber').length,
    green: entities.filter((e) => e.rag === 'green').length,
    readyToClose: close.summary.readyToClose,
    blocked: close.summary.blocked,
    closed: close.summary.closed,
  };

  return {
    period: { year, month, label },
    generatedAt: now.toISOString(),
    totals,
    entities,
    assignmentsAvailable: assignments.available,
  };
}
