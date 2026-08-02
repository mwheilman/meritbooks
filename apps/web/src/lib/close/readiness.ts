/**
 * Close orchestration — the RLS-scoped readiness loader.
 *
 * Turns live tenant data into the `CloseSignals` the pure orchestration engine
 * (`./orchestration.ts`) scores, and assembles the per-entity close-readiness board
 * plus the single-entity HARD_CLOSE gate the period-close transition consults.
 *
 * It REUSES existing machinery rather than duplicating it:
 *   • bank reconciliation ......... `gatherReconciliationCloseStatus` (the must-tie
 *                                    close gate) — its blocker count feeds the
 *                                    `reconciliations_tied` task. This is the
 *                                    additive extension of that gate, not a fork.
 *   • uncategorized/unposted ...... `scanUncategorizedLeakage` (EC-4) DRY-RUN — its
 *                                    close-readiness rolls up per entity.
 *   • AR/AP subledger tie ......... `v_ar_aging` / `v_ap_aging` Σ balances vs the
 *                                    AR/AP control account net balance in
 *                                    `v_trial_balance` (`resolveRole`).
 *   • review queue ................ `ai_decisions` status='PROPOSED' per entity.
 *
 * Manual sign-off state is stored in the existing `close_checklists` table (no new
 * table): one row per (fiscal_period_id, location_id, task_name = CloseTaskKey).
 *
 * Every read runs through the RLS-scoped client, so tenant isolation is enforced by
 * the database. All money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gatherReconciliationCloseStatus } from '@/lib/services/reconciliation-close-gate';
import { scanUncategorizedLeakage } from '@/lib/controls/uncategorized-leakage';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  evaluateCloseGraph,
  evaluateHardCloseGate,
  getCloseTask,
  MANUAL_TASK_KEYS,
  type CloseSignals,
  type CloseGraphEvaluation,
  type CloseTaskKey,
  type HardCloseGateResult,
} from './orchestration';

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const ROW_CAP = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared control-account resolution + subledger variance
// ─────────────────────────────────────────────────────────────────────────────

interface SubledgerMaps {
  /** AR |variance| in cents per location; null-safe (control unresolved ⇒ absent). */
  arVariance: Map<string, number> | null;
  apVariance: Map<string, number> | null;
}

/** |glControl − subledger| per location for AR & AP. `null` map ⇒ control unmapped. */
async function loadSubledgerVariance(supabase: SupabaseClient, orgId: string): Promise<SubledgerMaps> {
  const out: SubledgerMaps = { arVariance: null, apVariance: null };

  // AR ── open receivable balances vs the AR control account.
  try {
    const ar = await resolveRole(supabase, orgId, 'AR_CONTROL');
    const [{ data: aging }, { data: tb }] = await Promise.all([
      supabase.from('v_ar_aging').select('location_id, balance_cents').limit(ROW_CAP),
      supabase.from('v_trial_balance').select('location_id, net_balance').eq('account_id', ar.id).limit(ROW_CAP),
    ]);
    const sub = new Map<string, number>();
    for (const r of (aging ?? []) as Array<{ location_id: string | null; balance_cents: number | string }>) {
      if (!r.location_id) continue;
      sub.set(r.location_id, (sub.get(r.location_id) ?? 0) + num(r.balance_cents));
    }
    const gl = new Map<string, number>();
    for (const r of (tb ?? []) as Array<{ location_id: string | null; net_balance: number | string }>) {
      if (!r.location_id) continue;
      gl.set(r.location_id, (gl.get(r.location_id) ?? 0) + num(r.net_balance));
    }
    const variance = new Map<string, number>();
    for (const loc of new Set([...sub.keys(), ...gl.keys()])) {
      variance.set(loc, Math.abs((gl.get(loc) ?? 0) - (sub.get(loc) ?? 0)));
    }
    out.arVariance = variance;
  } catch (e) {
    if (!(e instanceof PostingError)) console.warn('[close/readiness] AR tie failed:', e instanceof Error ? e.message : e);
  }

  // AP ── open payable balances vs the AP control account.
  try {
    const ap = await resolveRole(supabase, orgId, 'AP_CONTROL');
    const [{ data: aging }, { data: tb }] = await Promise.all([
      supabase.from('v_ap_aging').select('location_id, balance_cents').limit(ROW_CAP),
      supabase.from('v_trial_balance').select('location_id, net_balance').eq('account_id', ap.id).limit(ROW_CAP),
    ]);
    const sub = new Map<string, number>();
    for (const r of (aging ?? []) as Array<{ location_id: string | null; balance_cents: number | string }>) {
      if (!r.location_id) continue;
      sub.set(r.location_id, (sub.get(r.location_id) ?? 0) + num(r.balance_cents));
    }
    const gl = new Map<string, number>();
    for (const r of (tb ?? []) as Array<{ location_id: string | null; net_balance: number | string }>) {
      if (!r.location_id) continue;
      gl.set(r.location_id, (gl.get(r.location_id) ?? 0) + num(r.net_balance));
    }
    const variance = new Map<string, number>();
    for (const loc of new Set([...sub.keys(), ...gl.keys()])) {
      variance.set(loc, Math.abs((gl.get(loc) ?? 0) - (sub.get(loc) ?? 0)));
    }
    out.apVariance = variance;
  } catch (e) {
    if (!(e instanceof PostingError)) console.warn('[close/readiness] AP tie failed:', e instanceof Error ? e.message : e);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual check-off state (reuses close_checklists)
// ─────────────────────────────────────────────────────────────────────────────

interface ChecklistRow {
  location_id: string;
  task_name: string;
  is_complete: boolean | null;
}

/** Manual check-offs per location: Set<CloseTaskKey> keyed by location_id. */
async function loadManualCheckoffs(
  supabase: SupabaseClient,
  periodIds: string[],
): Promise<Map<string, Set<CloseTaskKey>>> {
  const byLoc = new Map<string, Set<CloseTaskKey>>();
  if (periodIds.length === 0) return byLoc;
  const { data } = await supabase
    .from('close_checklists')
    .select('location_id, task_name, is_complete')
    .in('fiscal_period_id', periodIds)
    .in('task_name', MANUAL_TASK_KEYS as unknown as string[]);
  for (const r of (data ?? []) as ChecklistRow[]) {
    if (!r.is_complete) continue;
    if (!(MANUAL_TASK_KEYS as readonly string[]).includes(r.task_name)) continue;
    const set = byLoc.get(r.location_id) ?? new Set<CloseTaskKey>();
    set.add(r.task_name as CloseTaskKey);
    byLoc.set(r.location_id, set);
  }
  return byLoc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Board (all entities, one period)
// ─────────────────────────────────────────────────────────────────────────────

export type BoardPeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';

export interface EntityCloseOrchestration {
  locationId: string;
  name: string;
  shortCode: string;
  periodId: string | null;
  periodStatus: BoardPeriodStatus;
  closedAt: string | null;
  signals: CloseSignals;
  evaluation: CloseGraphEvaluation;
  /** The gate as it stands WITHOUT an override — what a clean hard-close would face. */
  gate: HardCloseGateResult;
}

export interface CloseOrchestrationSummary {
  totalEntities: number;
  readyToClose: number; // graph clean (all blocking pass) AND still open
  blocked: number; // open with ≥1 blocking task failing
  closed: number; // already HARD_CLOSE
  noPeriod: number;
}

export interface CloseOrchestrationBoard {
  period: { year: number; month: number; key: string; label: string };
  generatedAt: string;
  summary: CloseOrchestrationSummary;
  entities: EntityCloseOrchestration[];
}

interface LocationRow {
  id: string;
  name: string;
  short_code: string;
}
interface PeriodRow {
  id: string;
  location_id: string;
  status: BoardPeriodStatus;
  closed_at: string | null;
}

/**
 * Assemble the per-entity close-orchestration board for a fiscal month across all
 * active entities. Shared control resolution + the EC-4 leakage scan run ONCE; the
 * reconciliation gate runs per entity (a bounded fan-out over active entities).
 */
export async function gatherCloseOrchestration(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
  month: number,
): Promise<CloseOrchestrationBoard> {
  const now = new Date();
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const periodLabel = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const { data: locData } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');
  const locations = (locData ?? []) as LocationRow[];

  const { data: periodData } = await supabase
    .from('fiscal_periods')
    .select('id, location_id, status, closed_at')
    .eq('period_year', year)
    .eq('period_month', month);
  const periods = (periodData ?? []) as PeriodRow[];
  const periodByLoc = new Map<string, PeriodRow>();
  for (const p of periods) periodByLoc.set(p.location_id, p);
  const periodIds = periods.map((p) => p.id);

  // Shared, run-once reads.
  const [subledger, leakage, aiRes, checkoffsByLoc] = await Promise.all([
    loadSubledgerVariance(supabase, orgId),
    scanUncategorizedLeakage(supabase, orgId, { dryRun: true, asOfISO: now.toISOString() }),
    supabase.from('ai_decisions').select('location_id').eq('status', 'PROPOSED').limit(ROW_CAP),
    loadManualCheckoffs(supabase, periodIds),
  ]);

  // Per-entity leakage roll-up (across all aged periods — how a controller reasons).
  const leakUncodedBank = new Map<string, number>();
  const leakBlocking = new Map<string, number>();
  const leakItems = new Map<string, number>();
  for (const row of leakage.closeReadiness.byCompanyPeriod) {
    if (!row.locationId) continue;
    const loc = row.locationId;
    leakUncodedBank.set(loc, (leakUncodedBank.get(loc) ?? 0) + row.byKind.uncoded_bank);
    leakItems.set(loc, (leakItems.get(loc) ?? 0) + row.items);
    if (row.tier === 'escalate') leakBlocking.set(loc, (leakBlocking.get(loc) ?? 0) + row.atRiskCents);
  }

  const openExc = new Map<string, number>();
  for (const r of (aiRes.data ?? []) as Array<{ location_id: string | null }>) {
    if (!r.location_id) continue;
    openExc.set(r.location_id, (openExc.get(r.location_id) ?? 0) + 1);
  }

  // Reconciliation gate per entity (only where a period exists to reconcile).
  const reconByLoc = new Map<string, number>();
  await Promise.all(
    locations.map(async (loc) => {
      const period = periodByLoc.get(loc.id);
      if (!period) return;
      try {
        const g = await gatherReconciliationCloseStatus(supabase, { locationId: loc.id, fiscalPeriodId: period.id });
        reconByLoc.set(loc.id, g.blockers.length);
      } catch {
        reconByLoc.set(loc.id, 1); // fail closed — cannot confirm ⇒ treat as a blocker
      }
    }),
  );

  const entities: EntityCloseOrchestration[] = locations.map((loc) => {
    const period = periodByLoc.get(loc.id) ?? null;
    const signals: CloseSignals = {
      uncodedBankCents: leakUncodedBank.get(loc.id) ?? 0,
      reconciliationBlockers: reconByLoc.get(loc.id) ?? 0,
      arVarianceCents: subledger.arVariance ? subledger.arVariance.get(loc.id) ?? 0 : null,
      apVarianceCents: subledger.apVariance ? subledger.apVariance.get(loc.id) ?? 0 : null,
      blockingLeakageCents: leakBlocking.get(loc.id) ?? 0,
      leakageItems: leakItems.get(loc.id) ?? 0,
      openExceptions: openExc.get(loc.id) ?? 0,
    };
    const checkoffs = checkoffsByLoc.get(loc.id) ?? new Set<CloseTaskKey>();
    const evaluation = evaluateCloseGraph(signals, checkoffs);
    const gate = evaluateHardCloseGate(evaluation, null);
    return {
      locationId: loc.id,
      name: loc.name,
      shortCode: loc.short_code,
      periodId: period?.id ?? null,
      periodStatus: period?.status ?? 'NO_PERIOD',
      closedAt: period?.closed_at ?? null,
      signals,
      evaluation,
      gate,
    };
  });

  // Worst-first: blocked (open) → ready (open) → closed → no period.
  const rank = (e: EntityCloseOrchestration): number => {
    if (e.periodStatus === 'NO_PERIOD') return 0;
    if (e.periodStatus === 'HARD_CLOSE') return 1;
    return e.evaluation.readyToHardClose ? 2 : 3;
  };
  entities.sort((a, b) => rank(b) - rank(a) || b.evaluation.blockers.length - a.evaluation.blockers.length);

  const isOpen = (e: EntityCloseOrchestration) => e.periodStatus === 'OPEN' || e.periodStatus === 'SOFT_CLOSE';
  const summary: CloseOrchestrationSummary = {
    totalEntities: entities.length,
    readyToClose: entities.filter((e) => isOpen(e) && e.evaluation.readyToHardClose).length,
    blocked: entities.filter((e) => isOpen(e) && !e.evaluation.readyToHardClose).length,
    closed: entities.filter((e) => e.periodStatus === 'HARD_CLOSE').length,
    noPeriod: entities.filter((e) => e.periodStatus === 'NO_PERIOD').length,
  };

  return { period: { year, month, key: periodKey, label: periodLabel }, generatedAt: now.toISOString(), summary, entities };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-entity signals + HARD_CLOSE gate (period-close transition)
// ─────────────────────────────────────────────────────────────────────────────

/** Live `CloseSignals` for one entity + period (used by the hard-close gate). */
export async function gatherCloseSignals(
  supabase: SupabaseClient,
  orgId: string,
  args: { locationId: string; fiscalPeriodId: string },
): Promise<CloseSignals> {
  const [subledger, leakage, recon, aiRes] = await Promise.all([
    loadSubledgerVariance(supabase, orgId),
    scanUncategorizedLeakage(supabase, orgId, { dryRun: true }),
    gatherReconciliationCloseStatus(supabase, args).catch(() => null),
    supabase.from('ai_decisions').select('location_id').eq('status', 'PROPOSED').eq('location_id', args.locationId).limit(ROW_CAP),
  ]);

  let uncodedBankCents = 0;
  let blockingLeakageCents = 0;
  let leakageItems = 0;
  for (const row of leakage.closeReadiness.byCompanyPeriod) {
    if (row.locationId !== args.locationId) continue;
    uncodedBankCents += row.byKind.uncoded_bank;
    leakageItems += row.items;
    if (row.tier === 'escalate') blockingLeakageCents += row.atRiskCents;
  }

  return {
    uncodedBankCents,
    // A null recon read fails closed (1 blocker) — never silently allow a close.
    reconciliationBlockers: recon ? recon.blockers.length : 1,
    arVarianceCents: subledger.arVariance ? subledger.arVariance.get(args.locationId) ?? 0 : null,
    apVarianceCents: subledger.apVariance ? subledger.apVariance.get(args.locationId) ?? 0 : null,
    blockingLeakageCents,
    leakageItems,
    openExceptions: (aiRes.data ?? []).length,
  };
}

export interface HardCloseGateBundle {
  gate: HardCloseGateResult;
  evaluation: CloseGraphEvaluation;
  signals: CloseSignals;
}

/**
 * The additive HARD_CLOSE gate the period-close transition consults. Loads live
 * signals + manual check-offs for the entity/period, evaluates the task graph, and
 * applies the blocking gate (with an optional authorized override reason).
 *
 * This EXTENDS the bank-reconciliation close gate: reconciliation is now one of the
 * blocking tasks inside the graph, not a separate check.
 */
export async function gatherHardCloseGate(
  supabase: SupabaseClient,
  orgId: string,
  args: { locationId: string; fiscalPeriodId: string; overrideReason?: string | null },
): Promise<HardCloseGateBundle> {
  const [signals, checkoffMap] = await Promise.all([
    gatherCloseSignals(supabase, orgId, args),
    loadManualCheckoffs(supabase, [args.fiscalPeriodId]),
  ]);
  const checkoffs = checkoffMap.get(args.locationId) ?? new Set<CloseTaskKey>();
  const evaluation = evaluateCloseGraph(signals, checkoffs);
  const gate = evaluateHardCloseGate(evaluation, args.overrideReason ?? null);
  return { gate, evaluation, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual check-off write (upsert into close_checklists — no new table)
// ─────────────────────────────────────────────────────────────────────────────

export interface SetManualTaskArgs {
  orgId: string;
  fiscalPeriodId: string;
  locationId: string;
  taskKey: CloseTaskKey;
  isComplete: boolean;
  actorCoreUserId: string | null;
}

/**
 * Record (or clear) a manual close task's sign-off. Upserts a `close_checklists`
 * row keyed by (fiscal_period_id, location_id, task_name). No unique constraint is
 * assumed — reads then updates or inserts. Returns false on a write error.
 */
export async function setManualCloseTask(supabase: SupabaseClient, args: SetManualTaskArgs): Promise<boolean> {
  const def = getCloseTask(args.taskKey);
  const nowIso = new Date().toISOString();

  const { data: existing } = await supabase
    .from('close_checklists')
    .select('id')
    .eq('fiscal_period_id', args.fiscalPeriodId)
    .eq('location_id', args.locationId)
    .eq('task_name', args.taskKey)
    .maybeSingle();

  const completion = {
    is_complete: args.isComplete,
    completed_by: args.isComplete ? args.actorCoreUserId : null,
    completed_at: args.isComplete ? nowIso : null,
  };

  if (existing) {
    const { error } = await supabase.from('close_checklists').update(completion).eq('id', (existing as { id: string }).id);
    if (error) {
      console.error('[close/readiness] manual task update failed:', error.message);
      return false;
    }
    return true;
  }

  const { error } = await supabase.from('close_checklists').insert({
    org_id: args.orgId,
    fiscal_period_id: args.fiscalPeriodId,
    location_id: args.locationId,
    phase: def.phase,
    task_name: args.taskKey,
    task_order: def.order,
    due_day: def.dueDay,
    is_auto_verified: false,
    ...completion,
  });
  if (error) {
    console.error('[close/readiness] manual task insert failed:', error.message);
    return false;
  }
  return true;
}
