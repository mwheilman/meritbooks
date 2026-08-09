/**
 * PURE, side-effect-free helpers for the expense APPROVER QUEUE and the
 * REIMBURSEMENT BATCH surfaces. No I/O, no clock injected by default only where
 * a caller opts in — so every function is deterministic and unit-testable.
 *
 * These functions only READ already-computed facts (the `policy_reasons` the
 * deterministic engine stored on each line, and timestamps). They never post,
 * never re-run the policy engine, and never touch the reimbursement GL path —
 * they exist purely to SURFACE what the workflow already decided.
 */

import type { PolicySeverity } from './policy';

/**
 * The stored shape of one `policy_reasons` entry as it comes back from the DB.
 * Deliberately looser than the engine's `PolicyFlag` (whose `code` is a narrow
 * union) so this reader accepts any persisted rule code without coupling to the
 * engine's exhaustive enum.
 */
export interface StoredReason {
  code: string;
  message: string;
  severity: PolicySeverity;
}

// ---------------------------------------------------------------------------
// Policy-violation summary (which lines tripped which rule, WARN vs BLOCK)
// ---------------------------------------------------------------------------

export interface LineViolationsInput {
  lineNumber: number;
  merchant: string | null;
  description: string | null;
  amountCents: number;
  /** The `policy_reasons` the engine stored on the line (may be empty). */
  reasons: StoredReason[];
}

/** One rule kind, rolled up across every line that tripped it. */
export interface ViolationGroup {
  code: string;
  severity: PolicySeverity;
  /** Total number of tripped instances across all lines. */
  count: number;
  /** A representative human-readable message for the rule. */
  message: string;
  /** Line numbers that tripped this rule (ascending, de-duplicated). */
  lineNumbers: number[];
}

export interface ViolationSummary {
  blockCount: number;
  warnCount: number;
  infoCount: number;
  /** How many distinct lines carry at least one violation. */
  flaggedLineCount: number;
  /** Grouped by rule, ordered BLOCK → WARN → INFO, then by count desc. */
  groups: ViolationGroup[];
}

const SEVERITY_RANK: Record<PolicySeverity, number> = { block: 0, warn: 1, info: 2 };

/** True when the severity is a hard stop (gates submission absent an override). */
export function isBlocking(severity: PolicySeverity): boolean {
  return severity === 'block';
}

/**
 * Roll up every line's stored `policy_reasons` into a per-rule summary plus the
 * WARN/BLOCK/INFO counts. Deterministic: groups are ordered by severity then by
 * how many times the rule tripped, and line numbers within a group are sorted.
 */
export function summarizeViolations(lines: LineViolationsInput[]): ViolationSummary {
  const groups = new Map<string, ViolationGroup>();
  let blockCount = 0;
  let warnCount = 0;
  let infoCount = 0;
  let flaggedLineCount = 0;

  for (const line of lines) {
    const reasons = Array.isArray(line.reasons) ? line.reasons : [];
    if (reasons.length > 0) flaggedLineCount += 1;

    for (const r of reasons) {
      if (r.severity === 'block') blockCount += 1;
      else if (r.severity === 'warn') warnCount += 1;
      else infoCount += 1;

      const existing = groups.get(r.code);
      if (existing) {
        existing.count += 1;
        if (!existing.lineNumbers.includes(line.lineNumber)) {
          existing.lineNumbers.push(line.lineNumber);
        }
      } else {
        groups.set(r.code, {
          code: r.code,
          severity: r.severity,
          count: 1,
          message: r.message,
          lineNumbers: [line.lineNumber],
        });
      }
    }
  }

  const ordered = Array.from(groups.values())
    .map((g) => ({ ...g, lineNumbers: [...g.lineNumbers].sort((a, b) => a - b) }))
    .sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      if (b.count !== a.count) return b.count - a.count;
      return a.code.localeCompare(b.code);
    });

  return { blockCount, warnCount, infoCount, flaggedLineCount, groups: ordered };
}

/** Lightweight severity tally used by the list route (per-report roll-up). */
export function tallySeverities(reasons: StoredReason[][]): {
  block: number;
  warn: number;
  info: number;
} {
  let block = 0;
  let warn = 0;
  let info = 0;
  for (const lineReasons of reasons) {
    for (const r of Array.isArray(lineReasons) ? lineReasons : []) {
      if (r.severity === 'block') block += 1;
      else if (r.severity === 'warn') warn += 1;
      else info += 1;
    }
  }
  return { block, warn, info };
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

/** Whole days elapsed between an ISO timestamp and `now`. Null-safe. */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const ms = now.getTime() - then;
  if (ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/** Compact aging label for a submitted/approved timestamp. */
export function agingLabel(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/**
 * Aging bucket used to color the badge. Reports that have waited a while for
 * approval or payout should stand out.
 */
export type AgingTone = 'fresh' | 'aging' | 'stale';
export function agingTone(days: number | null): AgingTone {
  if (days === null) return 'fresh';
  if (days >= 7) return 'stale';
  if (days >= 3) return 'aging';
  return 'fresh';
}
