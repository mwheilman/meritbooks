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
  /**
   * Close-schedule target (owner KPI #3): the books for a fiscal month should be
   * HARD_CLOSE by this business day of the FOLLOWING month. A close stamped after
   * that day is "late." Tenant-overridable.
   */
  closeBusinessDay: 5,
  /**
   * Regulatory filing target (owner KPI #4): days of grace after a filing's due
   * date before it counts as late. 0 = the due date itself is the deadline.
   */
  filingGraceDays: 0,
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
    closeBusinessDay: overrides?.closeBusinessDay ?? DEFAULT_TARGETS.closeBusinessDay,
    filingGraceDays: overrides?.filingGraceDays ?? DEFAULT_TARGETS.filingGraceDays,
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

const DAY_MS_KPI = 86_400_000;

// ── VOLUME BY DOLLARS (owner KPI #2) ─────────────────────────────────────────
//
// The owner's second named KPI: not just "how many items" but "how much MONEY did
// each person move." Attribution is the same action_log spine — we join a person's
// finished-work actions to the underlying record's amount (JE debit total posted,
// bill $ approved, invoice $ issued, payroll gross approved, disbursement $ released).
// All money is bigint cents.

export type DollarFamily = 'journal' | 'bill' | 'invoice' | 'payroll' | 'payments';

export interface DollarItem {
  family: DollarFamily;
  cents: number;
}

export interface DollarResult {
  totalCents: number;
  byFamily: Record<DollarFamily, number>;
}

export function emptyDollarFamilies(): Record<DollarFamily, number> {
  return { journal: 0, bill: 0, invoice: 0, payroll: 0, payments: 0 };
}

/**
 * Sum the dollar VALUE (cents) one person processed, bucketed by work family.
 * Non-finite or non-positive amounts are ignored so a malformed row can never
 * corrupt the roll-up (a $0 or negative cannot be "dollars processed").
 */
export function computeDollars(items: DollarItem[]): DollarResult {
  const byFamily = emptyDollarFamilies();
  let totalCents = 0;
  for (const it of items) {
    if (!it || !Number.isFinite(it.cents) || it.cents <= 0) continue;
    const c = Math.round(it.cents);
    byFamily[it.family] += c;
    totalCents += c;
  }
  return { totalCents, byFamily };
}

// ── CLOSE-SCHEDULE ADHERENCE (owner KPI #3) ──────────────────────────────────

/** Calendar days from a→b (floor). Null if either timestamp is missing/unparseable. */
export function calendarDaysBetween(
  aIso: string | null | undefined,
  bIso: string | null | undefined,
): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / DAY_MS_KPI);
}

/**
 * The Nth business day (Mon–Fri; no holiday calendar — deterministic) of a month,
 * UTC. Clamps to the LAST business day if the month has fewer than n business days.
 */
export function nthBusinessDayOfMonthUTC(year: number, month1: number, n: number): Date {
  let count = 0;
  let last = new Date(Date.UTC(year, month1 - 1, 1));
  const target = Math.max(1, Math.floor(n));
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month1 - 1, day));
    if (d.getUTCMonth() !== month1 - 1) break; // ran past the end of the month
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      last = d;
      count += 1;
      if (count >= target) return d;
    }
  }
  return last;
}

/**
 * The close DUE date for a fiscal period: the Nth business day of the month AFTER
 * the period month (books close early in the following month). UTC midnight of the
 * due day.
 */
export function closeDueDateForPeriod(periodYear: number, periodMonth: number, businessDay: number): Date {
  let y = periodYear;
  let m = periodMonth + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return nthBusinessDayOfMonthUTC(y, m, businessDay);
}

/** On time if the close timestamp is on/before the end of the due day. Null if not closed. */
export function isCloseOnTime(closedAtIso: string | null | undefined, dueDate: Date): boolean | null {
  if (!closedAtIso) return null;
  const c = Date.parse(closedAtIso);
  if (Number.isNaN(c)) return null;
  return c <= dueDate.getTime() + DAY_MS_KPI - 1;
}

export interface ClosePeriodEval {
  closed: boolean;
  onTime: boolean | null;
  daysToClose: number | null;
}

export interface CloseAdherence {
  closedCount: number;
  onTimeCount: number;
  lateCount: number;
  /** on-time % among CLOSED periods with a determinable on-time verdict; null if none. */
  onTimePct: number | null;
  avgDaysToClose: number | null;
}

export function rollupCloseAdherence(items: ClosePeriodEval[]): CloseAdherence {
  let closedCount = 0;
  let onTimeCount = 0;
  let lateCount = 0;
  let dtcSum = 0;
  let dtcN = 0;
  for (const it of items) {
    if (!it.closed) continue;
    closedCount += 1;
    if (it.onTime === true) onTimeCount += 1;
    else if (it.onTime === false) lateCount += 1;
    if (it.daysToClose != null && Number.isFinite(it.daysToClose)) {
      dtcSum += it.daysToClose;
      dtcN += 1;
    }
  }
  const determinable = onTimeCount + lateCount;
  return {
    closedCount,
    onTimeCount,
    lateCount,
    onTimePct: determinable > 0 ? Math.round((onTimeCount / determinable) * 10000) / 10000 : null,
    avgDaysToClose: dtcN > 0 ? Math.round((dtcSum / dtcN) * 10) / 10 : null,
  };
}

// ── REGULATORY FILING-SCHEDULE ADHERENCE (owner KPI #4) ──────────────────────

/** On time if filed on/before the end of the due day (+ optional grace). Null if unknown. */
export function isFilingOnTime(
  filedAtIso: string | null | undefined,
  dueDateIso: string | null | undefined,
  graceDays = 0,
): boolean | null {
  if (!filedAtIso || !dueDateIso) return null;
  const f = Date.parse(filedAtIso);
  const due = Date.parse(dueDateIso);
  if (Number.isNaN(f) || Number.isNaN(due)) return null;
  const deadline = due + (Math.max(0, graceDays) + 1) * DAY_MS_KPI - 1;
  return f <= deadline;
}

export interface FilingEval {
  filed: boolean;
  /** determinable only for filed rows that carry a filed timestamp. */
  onTime: boolean | null;
  /** unfiled AND past its due date. */
  overdue: boolean;
}

export interface FilingAdherence {
  /** obligations that have come due (filed OR overdue) in the window. */
  totalDue: number;
  filedCount: number;
  filedOnTime: number;
  filedLate: number;
  overdueCount: number;
  /** filedOnTime / (filedOnTime + filedLate); null when nothing is determinable. */
  onTimePct: number | null;
}

export function rollupFilingAdherence(items: FilingEval[]): FilingAdherence {
  let filedCount = 0;
  let filedOnTime = 0;
  let filedLate = 0;
  let overdueCount = 0;
  let totalDue = 0;
  for (const it of items) {
    if (it.filed) {
      filedCount += 1;
      if (it.onTime === true) filedOnTime += 1;
      else if (it.onTime === false) filedLate += 1;
    }
    if (it.overdue) overdueCount += 1;
    if (it.filed || it.overdue) totalDue += 1;
  }
  const determinable = filedOnTime + filedLate;
  return {
    totalDue,
    filedCount,
    filedOnTime,
    filedLate,
    overdueCount,
    onTimePct: determinable > 0 ? Math.round((filedOnTime / determinable) * 10000) / 10000 : null,
  };
}
