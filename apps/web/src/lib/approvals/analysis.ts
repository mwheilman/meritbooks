/**
 * APPROVAL WORKFLOWS — read-only ADMIN ANALYSIS (pure, side-effect-free).
 *
 * This module deepens the *settings* experience for approval chains WITHOUT touching
 * how approvals are enforced at money-movement time. It answers three admin questions,
 * all as deterministic functions over already-loaded chain definitions:
 *
 *   1. `simulateChain(workflows, docType, amountCents)` — "if I submit THIS document,
 *      which chain applies and exactly who must approve, in what order?" A pure
 *      resolution against the active chain for the doc type (reuses the enforcement
 *      engine's `applicableSteps`, so the simulation can never disagree with reality).
 *
 *   2. `bandCoverageGaps(steps)` — the amount ranges (over [$0, ∞)) that NO step covers.
 *      A gap means documents in that band fall through to single-approver behavior.
 *
 *   3. `detectCoverageGaps(workflows, opts)` — per document type, flag: no active chain
 *      at all; uncovered amount bands; steps that name an unknown role; and (when active
 *      role membership counts are supplied) steps whose required authority NO active
 *      member could satisfy — a dead step that would strand documents.
 *
 * No I/O, no clock, no randomness, no model — identical inputs always yield identical
 * output. The settings UI and the (read-only) coverage API feed plain data in. Money is
 * bigint cents throughout. Authority satisfaction reuses `roleMeetsStep` (a higher role
 * covers a lower requirement) so this mirrors the enforcement engine exactly.
 */

import { formatMoney } from '@meritbooks/shared';
import { ALL_ROLES, ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import {
  applicableSteps,
  roleMeetsStep,
  WORKFLOW_DOC_TYPES,
  type WorkflowStepDef,
  type WorkflowDocType,
} from './workflow';

/** The minimal chain shape the analysis needs — the settings list route already returns it. */
export interface AnalyzableWorkflow {
  id: string;
  docType: WorkflowDocType;
  name: string;
  active: boolean;
  steps: WorkflowStepDef[];
}

/** Human labels for the five workflow document types (single source for the settings UI). */
export const WORKFLOW_DOC_TYPE_LABEL: Record<WorkflowDocType, string> = {
  BILL: 'Bill / AP',
  JOURNAL_ENTRY: 'Journal entry',
  PAYMENT: 'Payment / money movement',
  EXPENSE: 'Expense report',
  PAYROLL: 'Payroll run',
};

function docTypeLabel(dt: WorkflowDocType): string {
  return WORKFLOW_DOC_TYPE_LABEL[dt] ?? dt;
}

function roleLabel(role: string): string {
  return ROLE_DEFINITIONS[role as UserRole]?.label ?? role;
}

/** True when a role string is a recognized Books RBAC role. */
export function isKnownRole(role: string): role is UserRole {
  return (ALL_ROLES as readonly string[]).includes(role);
}

/**
 * The single ACTIVE workflow for a doc type, or null. Mirrors the DB invariant
 * (one active chain per (org, doc_type)); if data ever violates it, the first active
 * wins deterministically.
 */
export function activeWorkflowFor(
  workflows: AnalyzableWorkflow[],
  docType: WorkflowDocType
): AnalyzableWorkflow | null {
  return workflows.find((w) => w.active && w.docType === docType) ?? null;
}

// ---------------------------------------------------------------------------
// 1. Scenario simulation
// ---------------------------------------------------------------------------

export type SimulationOutcome =
  /** No active chain for this doc type — the doc keeps single-approver behavior. */
  | { kind: 'NO_ACTIVE_WORKFLOW' }
  /** A chain exists but no band covers the amount — also single-approver (degrade-safe). */
  | { kind: 'NO_APPLICABLE_STEPS'; workflowId: string; workflowName: string }
  /** The amount routes into these ordered steps — the exact required approver sequence. */
  | { kind: 'CHAIN'; workflowId: string; workflowName: string; sequence: WorkflowStepDef[] };

/**
 * Resolve a hypothetical document (doc type + amount) to the approval chain that WOULD
 * apply and the exact ordered approver steps required. Pure — reuses the enforcement
 * engine's `applicableSteps` so the preview matches production routing precisely.
 */
export function simulateChain(
  workflows: AnalyzableWorkflow[],
  docType: WorkflowDocType,
  amountCents: number
): SimulationOutcome {
  const wf = activeWorkflowFor(workflows, docType);
  if (!wf) return { kind: 'NO_ACTIVE_WORKFLOW' };
  const sequence = applicableSteps(wf, amountCents);
  if (sequence.length === 0) {
    return { kind: 'NO_APPLICABLE_STEPS', workflowId: wf.id, workflowName: wf.name };
  }
  return { kind: 'CHAIN', workflowId: wf.id, workflowName: wf.name, sequence };
}

// ---------------------------------------------------------------------------
// 2. Amount-band coverage
// ---------------------------------------------------------------------------

/** An uncovered amount range. `toCents` null = open-ended (…and above). Inclusive bounds. */
export interface BandGap {
  fromCents: number;
  toCents: number | null;
}

/**
 * Given a chain's steps, return the integer-cent ranges over [0, ∞) that NO step's band
 * covers. A step covers [minAmountCents, maxAmountCents] (max null = ∞). Overlapping and
 * stacked bands are merged; the result is the complement within [0, ∞). Empty result =
 * full coverage from $0 up. Pure.
 */
export function bandCoverageGaps(steps: WorkflowStepDef[]): BandGap[] {
  if (steps.length === 0) return [{ fromCents: 0, toCents: null }];

  const intervals = steps
    .map((s) => ({
      lo: Math.max(0, s.minAmountCents),
      hi: s.maxAmountCents === null ? Infinity : s.maxAmountCents,
    }))
    .filter((iv) => iv.hi >= iv.lo)
    .sort((a, b) => a.lo - b.lo);

  const gaps: BandGap[] = [];
  let cursor = 0; // the next still-uncovered cent
  for (const iv of intervals) {
    if (iv.lo > cursor) {
      gaps.push({ fromCents: cursor, toCents: iv.lo - 1 });
    }
    const nextCursor = iv.hi === Infinity ? Infinity : iv.hi + 1;
    if (nextCursor > cursor) cursor = nextCursor;
    if (cursor === Infinity) break;
  }
  if (cursor !== Infinity) gaps.push({ fromCents: cursor, toCents: null });
  return gaps;
}

/** Format a band gap as a readable dollar range, e.g. "$0.00 – $99.99" or "$50,000.00 and up". */
export function formatBandGap(gap: BandGap): string {
  if (gap.toCents === null) return `${formatMoney(gap.fromCents)} and up`;
  return `${formatMoney(gap.fromCents)} – ${formatMoney(gap.toCents)}`;
}

// ---------------------------------------------------------------------------
// 3. Role satisfiability + coverage-gap detection
// ---------------------------------------------------------------------------

/**
 * True when at least one active member holds a role that can satisfy `required` (an equal
 * or higher-ranked role, per `roleMeetsStep`). `activeRoleCounts` maps a Books role to
 * the number of active members holding it. A step whose required authority is NOT
 * satisfiable is a dead step — documents that reach it can never be approved.
 */
export function roleIsSatisfiable(
  required: UserRole,
  activeRoleCounts: Record<string, number>
): boolean {
  return ALL_ROLES.some((r) => (activeRoleCounts[r] ?? 0) > 0 && roleMeetsStep(r, required));
}

export type GapSeverity = 'critical' | 'warning';

export type CoverageCode =
  | 'NO_ACTIVE_WORKFLOW'
  | 'AMOUNT_BAND_GAP'
  | 'UNKNOWN_ROLE'
  | 'UNSATISFIABLE_ROLE';

export interface CoverageFinding {
  docType: WorkflowDocType;
  docTypeLabel: string;
  code: CoverageCode;
  severity: GapSeverity;
  message: string;
  /** Present on AMOUNT_BAND_GAP. */
  bandFromCents?: number;
  bandToCents?: number | null;
  /** Present on role findings. */
  stepOrder?: number;
  role?: string;
}

export interface CoverageOptions {
  /** Which doc types to audit. Defaults to all five workflow doc types. */
  docTypes?: readonly WorkflowDocType[];
  /**
   * Active-member counts per Books role. When supplied, enables UNSATISFIABLE_ROLE
   * detection (a step no active member could ever approve). Omit to skip that check.
   */
  activeRoleCounts?: Record<string, number>;
}

/**
 * Deterministically flag coverage gaps in a tenant's configured approval chains. For each
 * audited doc type:
 *   - NO_ACTIVE_WORKFLOW  (warning) — no active chain; docs keep single-approver behavior.
 *   - AMOUNT_BAND_GAP     (warning) — an amount range no step covers (falls to single-approver).
 *   - UNKNOWN_ROLE        (critical) — a step names a role the RBAC catalog doesn't define.
 *   - UNSATISFIABLE_ROLE  (critical) — a step's required authority is held by no active member.
 * Pure; ordering is stable (by doc type, then the order above).
 */
export function detectCoverageGaps(
  workflows: AnalyzableWorkflow[],
  opts?: CoverageOptions
): CoverageFinding[] {
  const docTypes = opts?.docTypes ?? WORKFLOW_DOC_TYPES;
  const findings: CoverageFinding[] = [];

  for (const dt of docTypes) {
    const label = docTypeLabel(dt);
    const wf = activeWorkflowFor(workflows, dt);

    if (!wf) {
      findings.push({
        docType: dt,
        docTypeLabel: label,
        code: 'NO_ACTIVE_WORKFLOW',
        severity: 'warning',
        message: `No active approval chain for ${label}. These documents keep the existing single-approver behavior.`,
      });
      continue;
    }

    for (const gap of bandCoverageGaps(wf.steps)) {
      findings.push({
        docType: dt,
        docTypeLabel: label,
        code: 'AMOUNT_BAND_GAP',
        severity: 'warning',
        bandFromCents: gap.fromCents,
        bandToCents: gap.toCents,
        message: `${label}: amounts ${formatBandGap(gap)} match no step — they fall through to single-approver behavior.`,
      });
    }

    for (const s of wf.steps) {
      if (!isKnownRole(s.approverRole)) {
        findings.push({
          docType: dt,
          docTypeLabel: label,
          code: 'UNKNOWN_ROLE',
          severity: 'critical',
          stepOrder: s.stepOrder,
          role: s.approverRole,
          message: `${label} step ${s.stepOrder} references an unrecognized role "${s.approverRole}" — no one can satisfy it.`,
        });
        continue;
      }
      if (opts?.activeRoleCounts && !roleIsSatisfiable(s.approverRole, opts.activeRoleCounts)) {
        findings.push({
          docType: dt,
          docTypeLabel: label,
          code: 'UNSATISFIABLE_ROLE',
          severity: 'critical',
          stepOrder: s.stepOrder,
          role: s.approverRole,
          message: `${label} step ${s.stepOrder} requires ${roleLabel(s.approverRole)} authority, but no active member holds a role that can approve it.`,
        });
      }
    }
  }

  return findings;
}
