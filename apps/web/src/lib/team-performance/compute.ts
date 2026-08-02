/**
 * Team Performance — pure computation layer (FPB-team-performance §1).
 *
 * NO I/O. Every function here is a deterministic reducer over rows the route
 * fetches from `core.action_log` + the live ledger, so the fairness math
 * (difficulty-weighting T7, the quality gate M1, cycle-time averages C1–C5) is
 * unit-testable without a DB.
 *
 * CANON GUARDRAIL: attribution is keyed on `actorUserId` sourced from
 * `core.action_log.actor_user_id` — NEVER `gl_entries.created_by` (null for AI,
 * and written null on the bank-feed/JE paths). See CANON-ANCHOR §2.
 *
 * FAIRNESS (Dim 11): the headline is the difficulty-WEIGHTED composite, never
 * raw volume, and the leaderboard is quality-GATED — anyone over the rework
 * threshold is flagged, not celebrated. Weights + thresholds are tenant config
 * (public.performance_config, migration 074), falling back to the defaults here.
 */

export type WorkFamily =
  | 'categorize'
  | 'approve'
  | 'journal'
  | 'bill'
  | 'reconcile'
  | 'exception'
  | 'payroll'
  | 'other';

export interface WorkActionDef {
  family: WorkFamily;
  weight: number; // difficulty weight (T7) — batch-approve cheap, accrual JE dear
}

/**
 * The finished-work action catalog, keyed by the REAL `action` strings written to
 * core.action_log (verified against the codebase, Rule 11 — NOT the FPB's
 * idealized names). Only actions in this map count toward throughput/composite;
 * proposals ('ai.categorize.proposed'), generic 'accept'/'reject', reads, etc.
 * are deliberately excluded. Weights are overridable per-tenant.
 */
export const DEFAULT_WORK_ACTIONS: Record<string, WorkActionDef> = {
  // Family A — categorization (a one-click batch approve is cheap; hand-coding is the real work,
  // but we cannot see per-line difficulty here, so a single modest weight — override rate (Q4)
  // is the counterweight that stops rubber-stamping from looking productive).
  'bankfeed.approve': { family: 'categorize', weight: 1 },
  // AP
  'bill.create': { family: 'bill', weight: 1 },
  'bill.update': { family: 'bill', weight: 0.5 },
  'bill.approve': { family: 'approve', weight: 1.5 },
  // Manual / adjusting journal entries — high judgment.
  'gl.post': { family: 'journal', weight: 3 },
  // Money movement approvals
  'checks.approve': { family: 'approve', weight: 2 },
  'checks.run': { family: 'approve', weight: 2 },
  'payroll.run.create': { family: 'payroll', weight: 1.5 },
  'payroll.run.approve': { family: 'payroll', weight: 3 },
  'payroll.run.post': { family: 'payroll', weight: 3 },
  'payroll.run.release': { family: 'payroll', weight: 2 },
  // Reconciliation — finalize is the dear one; accepting a proposed match is cheap.
  'reconciliation.finalize': { family: 'reconcile', weight: 4 },
  'reconciliation.match.accept': { family: 'reconcile', weight: 0.5 },
  'reconciliation.adjustment': { family: 'reconcile', weight: 1 },
  // Supervisory
  'exception.resolve': { family: 'exception', weight: 1.5 },
  'period.status': { family: 'other', weight: 2 },
};

export const DEFAULT_TARGETS = {
  /** Rework rate above this GATES the leaderboard (person flagged, not celebrated). */
  reworkGate: 0.08,
  /** Override rate above this is a coaching/miscalibration flag (co-reported, not a gate). */
  overrideWatch: 0.35,
};

export type Targets = typeof DEFAULT_TARGETS;

/**
 * Resolve the effective action catalog: tenant overrides (from
 * performance_config.action_weights, shape `{ [action]: number }`) layered onto
 * the defaults. An override for an UNKNOWN action introduces it with family
 * 'other' so a tenant can score a workstream we didn't seed.
 */
export function resolveWorkActions(
  overrides: Record<string, number> | null | undefined
): Record<string, WorkActionDef> {
  const out: Record<string, WorkActionDef> = { ...DEFAULT_WORK_ACTIONS };
  if (overrides) {
    for (const [action, weight] of Object.entries(overrides)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) continue;
      const existing = out[action];
      out[action] = { family: existing?.family ?? 'other', weight };
    }
  }
  return out;
}

export function resolveTargets(overrides: Partial<Targets> | null | undefined): Targets {
  return {
    reworkGate: overrides?.reworkGate ?? DEFAULT_TARGETS.reworkGate,
    overrideWatch: overrides?.overrideWatch ?? DEFAULT_TARGETS.overrideWatch,
  };
}

// ── Throughput (Family A / T7) ───────────────────────────────────────────────

export interface ThroughputResult {
  /** Difficulty-weighted composite (T7) — the anti-gaming headline. */
  composite: number;
  /** Raw finished-work action count (shown ONLY paired with quality — never alone). */
  totalActions: number;
  byFamily: Record<WorkFamily, number>;
}

function emptyFamilyCounts(): Record<WorkFamily, number> {
  return {
    categorize: 0,
    approve: 0,
    journal: 0,
    bill: 0,
    reconcile: 0,
    exception: 0,
    payroll: 0,
    other: 0,
  };
}

/**
 * T7: difficulty-weighted throughput for one person's finished-work actions.
 * `actions` is the list of action strings that person performed in the window.
 * Unknown actions are ignored (not counted as volume) so unweighted noise cannot
 * inflate the score.
 */
export function computeThroughput(
  actions: string[],
  catalog: Record<string, WorkActionDef>
): ThroughputResult {
  const byFamily = emptyFamilyCounts();
  let composite = 0;
  let totalActions = 0;
  for (const action of actions) {
    const def = catalog[action];
    if (!def) continue;
    composite += def.weight;
    totalActions += 1;
    byFamily[def.family] += 1;
  }
  // Guard against fp drift so exact-cent-style assertions hold.
  composite = Math.round(composite * 1000) / 1000;
  return { composite, totalActions, byFamily };
}

// ── Cycle time (Family B / C1–C5) ────────────────────────────────────────────

/**
 * Milliseconds between two ISO timestamps, or null if either is missing/invalid
 * or the interval is negative (clock skew / out-of-order). Null propagates as
 * "n/a" — the FPB rule: return null when the data doesn't support the metric
 * (e.g. categorized_at is null on all historical rows), NEVER 0.
 */
export function latencyMs(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  if (!startIso || !endIso) return null;
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  const d = e - s;
  return d < 0 ? null : d;
}

/**
 * Cycle-time average helper (C1–C5). Mean of the non-null latencies; returns null
 * when there is NO usable datapoint (so an unpopulated metric reads "n/a", not a
 * misleading 0). Nulls are skipped, not treated as zero.
 */
export function averageLatencyMs(values: Array<number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || Number.isNaN(v)) continue;
    sum += v;
    n += 1;
  }
  if (n === 0) return null;
  return Math.round(sum / n);
}

/** Median of the non-null latencies, or null when empty. */
export function medianLatencyMs(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? Math.round((nums[mid - 1] + nums[mid]) / 2) : nums[mid];
}

export const msToHours = (ms: number | null): number | null =>
  ms == null ? null : Math.round((ms / 3_600_000) * 100) / 100;

// ── Quality (Family C) ───────────────────────────────────────────────────────

/**
 * A ratio that is null (n/a) when the denominator is 0 — so "no approvals yet"
 * shows as n/a, not a flattering 0%. Used for Q4 override rate and Q1 rework rate.
 */
export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

// ── Composite scoring + the quality GATE (M1) ────────────────────────────────

export interface ScorecardInput {
  userId: string;
  name: string;
  throughput: ThroughputResult;
  overrideRate: number | null; // Q4
  overrideSample: number;
  reworkRate: number | null; // Q1
  reworkSample: number;
}

export interface LeaderboardEntry {
  userId: string;
  name: string;
  composite: number;
  reworkRate: number | null;
  overrideRate: number | null;
  /** GATE: true => over the rework threshold; flagged, NOT eligible to be "top". */
  qualityFlag: boolean;
  rank: number; // 1-based, by composite desc
}

export interface Leaderboard {
  entries: LeaderboardEntry[];
  /** Highest-composite person who is NOT quality-flagged (the gated winner), or null. */
  topPerformerUserId: string | null;
}

/**
 * M1 leaderboard: rank by the difficulty-weighted composite (T7) — NEVER raw
 * volume — and GATE on quality. A person whose rework rate exceeds the tenant
 * threshold is flagged and is ineligible to be surfaced as top performer, even
 * if their composite is highest. This is the core anti-gaming construct: you
 * cannot win by cutting corners (fast, sloppy, later-reworked output).
 */
export function buildLeaderboard(cards: ScorecardInput[], targets: Targets): Leaderboard {
  const sorted = [...cards].sort((a, b) => b.throughput.composite - a.throughput.composite);
  const entries: LeaderboardEntry[] = sorted.map((c, i) => ({
    userId: c.userId,
    name: c.name,
    composite: c.throughput.composite,
    reworkRate: c.reworkRate,
    overrideRate: c.overrideRate,
    qualityFlag: c.reworkRate != null && c.reworkRate > targets.reworkGate,
    rank: i + 1,
  }));
  const top = entries.find((e) => !e.qualityFlag && e.composite > 0);
  return { entries, topPerformerUserId: top?.userId ?? null };
}
