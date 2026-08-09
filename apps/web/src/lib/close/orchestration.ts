/**
 * Close orchestration — the standard month-end close TASK GRAPH.
 *
 * The Close Command Center is upgraded from a flat, typed-in checklist into a real
 * ORCHESTRATION: an ordered, dependency-aware graph of close tasks where the
 * "boring but load-bearing" tasks AUTO-VERIFY from the live ledger and the
 * judgement tasks are MANUAL sign-offs. Nothing is asserted done — an auto task is
 * green only when the books say so (canon §4/§5: "Complete is demonstrated, not
 * asserted").
 *
 * The standard flow (each depends on the prior tie):
 *
 *   bank feeds imported/coded
 *        └─► bank reconciliations tied ($0)
 *                 ├─► AR subledger ties to GL control ($0 variance)
 *                 ├─► AP subledger ties to GL control ($0 variance)
 *                 └─► uncategorized/unposted leakage cleared (no material $)
 *        └─► review queue exceptions cleared (soft)
 *   AR/AP tied ─► accruals posted ─┐
 *              ─► prepaids posted  ├─► reviewed (final human sign-off)
 *              ─► depreciation     ┘
 *                                     └─► HARD CLOSE (the gate consumes this graph)
 *
 * This module is PURE and exhaustively unit-tested. It never touches the database:
 *   • `CLOSE_TASK_GRAPH` — the standard task definitions with dependencies.
 *   • `evaluateCloseGraph(signals, checkoffs)` — given the live auto-check numbers
 *     and the set of completed manual tasks, computes each task's status
 *     (pass / blocked / pending) respecting dependency ordering, plus overall
 *     close readiness.
 *   • `evaluateHardCloseGate(evaluation, overrideReason)` — the blocking gate:
 *     a period may HARD_CLOSE only when every BLOCKING task passes, unless an
 *     authorized user supplies an explicit override reason (audited by the caller).
 *
 * The RLS-scoped loader that produces `CloseSignals` from live data lives in
 * `./readiness.ts` (it reuses the existing bank-reconciliation close gate rather
 * than duplicating it). All money is bigint cents.
 */

import { formatMoney } from '@meritbooks/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Task graph
// ─────────────────────────────────────────────────────────────────────────────

export type CloseTaskKey =
  | 'bank_feeds_imported'
  | 'journal_drafts_posted'
  | 'reconciliations_tied'
  | 'ar_subledger_tie'
  | 'ap_subledger_tie'
  | 'uncategorized_cleared'
  | 'bills_on_hold_cleared'
  | 'unapplied_payments_cleared'
  | 'pending_approvals_cleared'
  | 'exceptions_cleared'
  | 'accruals_posted'
  | 'prepaids_posted'
  | 'depreciation_posted'
  | 'reviewed';

export type CloseTaskKind = 'AUTO' | 'MANUAL';
export type CloseTaskStatus = 'pass' | 'blocked' | 'pending';
export type ClosePhase = 'INITIAL' | 'MID_CLOSE' | 'FINAL';
/** Unit of the live number that drives an AUTO task's chip. */
export type DriverUnit = 'count' | 'cents' | 'none';

export interface CloseTaskDef {
  key: CloseTaskKey;
  label: string;
  description: string;
  kind: CloseTaskKind;
  /** A blocking task must pass (or be overridden) before HARD_CLOSE. */
  blocking: boolean;
  dependsOn: CloseTaskKey[];
  /** Grouping + storage phase (reuses close_phase_enum). */
  phase: ClosePhase;
  unit: DriverUnit;
  /** Stable display + close_checklists.task_order. */
  order: number;
  /** Target close day (close_checklists.due_day): INITIAL 3 · MID 7 · FINAL 10. */
  dueDay: number;
  /** Where the operator goes to clear this open item (in-app deep link). */
  deepLinkHref?: string;
}

/**
 * The standard close task graph. Ordered so every task's dependencies appear
 * earlier in the array (a hand-maintained topological order — asserted by the
 * unit tests). Reference tasks by role, never by index.
 */
export const CLOSE_TASK_GRAPH: readonly CloseTaskDef[] = [
  {
    key: 'bank_feeds_imported',
    label: 'Bank feeds imported & coded',
    description:
      'All bank/card activity for the period is captured and coded to the GL — no aged, uncategorized cash movement left sitting in the feed.',
    kind: 'AUTO',
    blocking: true,
    dependsOn: [],
    phase: 'INITIAL',
    unit: 'cents',
    order: 1,
    dueDay: 3,
    deepLinkHref: '/bank-feed',
  },
  {
    key: 'journal_drafts_posted',
    label: 'Draft journal entries posted',
    description:
      'No unposted (draft) journal entries are dated in this period. A draft that is not posted is not in the ledger, so the period P&L and balance sheet are incomplete until it is posted or discarded.',
    kind: 'AUTO',
    blocking: true,
    dependsOn: [],
    phase: 'INITIAL',
    unit: 'count',
    order: 2,
    dueDay: 3,
    deepLinkHref: '/journal-entries',
  },
  {
    key: 'reconciliations_tied',
    label: 'Bank reconciliations tied',
    description:
      'Every active bank account is reconciled for the period and ties to a $0 difference — no unexplained variance.',
    kind: 'AUTO',
    blocking: true,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'count',
    order: 3,
    dueDay: 7,
    deepLinkHref: '/reconciliation',
  },
  {
    key: 'ar_subledger_tie',
    label: 'AR subledger ties to GL',
    description:
      'The sum of open receivable balances equals the AR control account balance in the general ledger ($0 variance).',
    kind: 'AUTO',
    blocking: true,
    dependsOn: ['reconciliations_tied'],
    phase: 'MID_CLOSE',
    unit: 'cents',
    order: 4,
    dueDay: 7,
    deepLinkHref: '/collections',
  },
  {
    key: 'ap_subledger_tie',
    label: 'AP subledger ties to GL',
    description:
      'The sum of open payable balances equals the AP control account balance in the general ledger ($0 variance).',
    kind: 'AUTO',
    blocking: true,
    dependsOn: ['reconciliations_tied'],
    phase: 'MID_CLOSE',
    unit: 'cents',
    order: 5,
    dueDay: 7,
    deepLinkHref: '/bills',
  },
  {
    key: 'uncategorized_cleared',
    label: 'Uncategorized activity cleared',
    description:
      'No material aged economic activity is missing from the GL (EC-4) — the uncategorized/unposted leakage that quietly distorts the period P&L is resolved.',
    kind: 'AUTO',
    blocking: true,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'cents',
    order: 6,
    dueDay: 7,
    deepLinkHref: '/bank-feed',
  },
  {
    key: 'bills_on_hold_cleared',
    label: 'Bills on hold cleared',
    description:
      'No vendor bills are sitting in an on-hold state for this entity. An on-hold bill can hide an unrecorded liability or a dispute that belongs to the period — resolve or release each one before closing.',
    kind: 'AUTO',
    blocking: false,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'count',
    order: 7,
    dueDay: 7,
    deepLinkHref: '/bills',
  },
  {
    key: 'unapplied_payments_cleared',
    label: 'Customer payments applied',
    description:
      'Every customer payment received is applied to an invoice — no cash is left sitting unapplied. Unapplied receipts overstate open AR and distort the receivable subledger tie.',
    kind: 'AUTO',
    blocking: false,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'cents',
    order: 8,
    dueDay: 7,
    deepLinkHref: '/cash-application',
  },
  {
    key: 'pending_approvals_cleared',
    label: 'Pending approvals resolved',
    description:
      'No period-dated bill or journal entry is still waiting in an approval chain. A document pending approval is not yet posted, so the period is incomplete until each one is approved (and posted) or withdrawn.',
    kind: 'AUTO',
    blocking: true,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'count',
    order: 9,
    dueDay: 7,
    deepLinkHref: '/inbox',
  },
  {
    key: 'exceptions_cleared',
    label: 'Review queue cleared',
    description:
      'The AI/exception review queue for this entity is empty — every proposed decision has been approved or rejected by a human.',
    kind: 'AUTO',
    blocking: false,
    dependsOn: ['bank_feeds_imported'],
    phase: 'MID_CLOSE',
    unit: 'count',
    order: 10,
    dueDay: 7,
    deepLinkHref: '/exceptions',
  },
  {
    key: 'accruals_posted',
    label: 'Accruals posted',
    description:
      'Period-end accruals (unbilled expenses, accrued liabilities) are booked. Manual attestation by the preparer.',
    kind: 'MANUAL',
    blocking: true,
    dependsOn: ['ar_subledger_tie', 'ap_subledger_tie'],
    phase: 'FINAL',
    unit: 'none',
    order: 11,
    dueDay: 10,
  },
  {
    key: 'prepaids_posted',
    label: 'Prepaids amortized',
    description:
      'Prepaid expense amortization for the period is booked. Manual attestation by the preparer.',
    kind: 'MANUAL',
    blocking: true,
    dependsOn: ['ar_subledger_tie', 'ap_subledger_tie'],
    phase: 'FINAL',
    unit: 'none',
    order: 12,
    dueDay: 10,
  },
  {
    key: 'depreciation_posted',
    label: 'Depreciation posted',
    description:
      'Fixed-asset depreciation for the period is booked. Manual attestation by the preparer.',
    kind: 'MANUAL',
    blocking: true,
    dependsOn: ['ar_subledger_tie', 'ap_subledger_tie'],
    phase: 'FINAL',
    unit: 'none',
    order: 13,
    dueDay: 10,
  },
  {
    key: 'reviewed',
    label: 'Reviewed & approved to close',
    description:
      'Final controller review of the period is complete and the close is approved. Manual sign-off gating the hard close.',
    kind: 'MANUAL',
    blocking: true,
    dependsOn: [
      'journal_drafts_posted',
      'reconciliations_tied',
      'ar_subledger_tie',
      'ap_subledger_tie',
      'uncategorized_cleared',
      'pending_approvals_cleared',
      'accruals_posted',
      'prepaids_posted',
      'depreciation_posted',
    ],
    phase: 'FINAL',
    unit: 'none',
    order: 14,
    dueDay: 10,
  },
] as const;

export const MANUAL_TASK_KEYS: readonly CloseTaskKey[] = CLOSE_TASK_GRAPH.filter(
  (t) => t.kind === 'MANUAL',
).map((t) => t.key);

export const AUTO_TASK_KEYS: readonly CloseTaskKey[] = CLOSE_TASK_GRAPH.filter(
  (t) => t.kind === 'AUTO',
).map((t) => t.key);

const TASK_BY_KEY: Record<CloseTaskKey, CloseTaskDef> = Object.fromEntries(
  CLOSE_TASK_GRAPH.map((t) => [t.key, t]),
) as Record<CloseTaskKey, CloseTaskDef>;

export function getCloseTask(key: CloseTaskKey): CloseTaskDef {
  return TASK_BY_KEY[key];
}

export function isManualTaskKey(key: string): key is CloseTaskKey {
  return (MANUAL_TASK_KEYS as readonly string[]).includes(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live signals feeding the AUTO tasks
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseSignals {
  /** Aged, uncoded bank/card $ (EC-4 uncoded_bank). Ties when 0. */
  uncodedBankCents: number;
  /** Bank-reconciliation close-gate blockers (unreconciled / unexplained variance). Ties when 0. */
  reconciliationBlockers: number;
  /** |AR subledger − GL control|, cents. Ties when 0. `null` ⇒ control unresolved ⇒ cannot confirm. */
  arVarianceCents: number | null;
  /** |AP subledger − GL control|, cents. Ties when 0. `null` ⇒ control unresolved ⇒ cannot confirm. */
  apVarianceCents: number | null;
  /** Material (escalate-tier) uncategorized $ at risk. Ties when 0. */
  blockingLeakageCents: number;
  /** Total aged uncategorized/unposted items (display context). */
  leakageItems: number;
  /** Open review-queue exceptions (ai_decisions PROPOSED). Clear when 0. */
  openExceptions: number;
  /** Unposted (draft) journal entries dated in the period. Clear when 0. */
  unpostedDraftCount: number;
  /** Vendor bills sitting ON_HOLD for the entity (as of period end). Clear when 0. */
  billsOnHoldCount: number;
  /** Customer payments with cash still unapplied to an invoice. Clear when 0. */
  unappliedPaymentCount: number;
  /** Dollar amount of that unapplied customer cash (display context). */
  unappliedPaymentCents: number;
  /** Period-relevant bills/JEs still awaiting an approval decision. Clear when 0. */
  pendingApprovalCount: number;
}

/** Set of MANUAL task keys a human has checked off for an entity + period. */
export type ManualCheckoffs = ReadonlySet<CloseTaskKey>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatedCloseTask extends CloseTaskDef {
  status: CloseTaskStatus;
  /** The live number driving an AUTO chip (cents/count); null for MANUAL or unresolved. */
  driverValue: number | null;
  /** Human-readable driver, e.g. "$0 variance", "2 accounts not tied", "Checked off". */
  driverLabel: string;
  /** Dependencies all pass ⇒ the task is actionable now. */
  actionable: boolean;
  /** Why the task is not passing (blocked), else null. */
  reason: string | null;
}

export interface CloseGraphEvaluation {
  tasks: EvaluatedCloseTask[];
  /** Blocking tasks that are not passing (ordered) — these stop a hard close. */
  blockers: EvaluatedCloseTask[];
  /** Non-blocking tasks that are actionable-but-failing — surfaced as warnings. */
  warnings: EvaluatedCloseTask[];
  /** Every BLOCKING task passes ⇒ the period is ready to hard-close cleanly. */
  readyToHardClose: boolean;
  autoPass: number;
  autoTotal: number;
  manualDone: number;
  manualTotal: number;
  completedTasks: number;
  totalTasks: number;
  /** 0..100 of ALL tasks passing. */
  percentComplete: number;
}

interface AutoCheck {
  satisfied: boolean;
  driverValue: number | null;
  driverLabel: string;
  reason: string | null;
}

/** Evaluate a single AUTO task's live check into a pass/fail + display. */
function evaluateAuto(key: CloseTaskKey, s: CloseSignals): AutoCheck {
  switch (key) {
    case 'bank_feeds_imported': {
      const v = s.uncodedBankCents;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'All activity coded' : `${formatMoney(v)} uncoded`,
        reason: ok
          ? null
          : `${formatMoney(v)} of aged bank/card activity is not yet coded to the GL`,
      };
    }
    case 'reconciliations_tied': {
      const v = s.reconciliationBlockers;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'All accounts tied' : `${v} account(s) not tied`,
        reason: ok ? null : `${v} bank account(s) are unreconciled or carry an unexplained variance`,
      };
    }
    case 'ar_subledger_tie': {
      if (s.arVarianceCents === null) {
        return {
          satisfied: false,
          driverValue: null,
          driverLabel: 'AR control unmapped',
          reason: 'AR control account is not mapped — the subledger tie cannot be confirmed',
        };
      }
      const v = s.arVarianceCents;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'Ties to control' : `${formatMoney(v)} variance`,
        reason: ok ? null : `AR subledger differs from the GL control account by ${formatMoney(v)}`,
      };
    }
    case 'ap_subledger_tie': {
      if (s.apVarianceCents === null) {
        return {
          satisfied: false,
          driverValue: null,
          driverLabel: 'AP control unmapped',
          reason: 'AP control account is not mapped — the subledger tie cannot be confirmed',
        };
      }
      const v = s.apVarianceCents;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'Ties to control' : `${formatMoney(v)} variance`,
        reason: ok ? null : `AP subledger differs from the GL control account by ${formatMoney(v)}`,
      };
    }
    case 'uncategorized_cleared': {
      const v = s.blockingLeakageCents;
      const ok = v === 0;
      const items = s.leakageItems;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok
          ? items > 0
            ? `${items} item(s), none material`
            : 'Nothing outstanding'
          : `${formatMoney(v)} material`,
        reason: ok
          ? null
          : `${formatMoney(v)} of aged economic activity is material and still not in the GL`,
      };
    }
    case 'exceptions_cleared': {
      const v = s.openExceptions;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'Queue clear' : `${v} open exception(s)`,
        reason: ok ? null : `${v} proposal(s) await human review in the exception queue`,
      };
    }
    case 'journal_drafts_posted': {
      const v = s.unpostedDraftCount;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'All entries posted' : `${v} draft(s) unposted`,
        reason: ok ? null : `${v} journal ${v === 1 ? 'entry is' : 'entries are'} still in draft and not posted to this period`,
      };
    }
    case 'bills_on_hold_cleared': {
      const v = s.billsOnHoldCount;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'None on hold' : `${v} bill(s) on hold`,
        reason: ok ? null : `${v} vendor bill(s) are on hold and may represent an unrecorded liability or unresolved dispute`,
      };
    }
    case 'unapplied_payments_cleared': {
      const v = s.unappliedPaymentCents;
      const ok = v === 0;
      const n = s.unappliedPaymentCount;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'All applied' : `${formatMoney(v)} unapplied`,
        reason: ok ? null : `${formatMoney(v)} across ${n} customer payment(s) is received but not applied to an invoice`,
      };
    }
    case 'pending_approvals_cleared': {
      const v = s.pendingApprovalCount;
      const ok = v === 0;
      return {
        satisfied: ok,
        driverValue: v,
        driverLabel: ok ? 'None pending' : `${v} awaiting approval`,
        reason: ok ? null : `${v} period-dated bill(s)/journal entr${v === 1 ? 'y is' : 'ies are'} still awaiting an approval decision`,
      };
    }
    default:
      // Exhaustiveness: MANUAL keys never reach here.
      return { satisfied: false, driverValue: null, driverLabel: '', reason: 'Not an auto task' };
  }
}

/**
 * Evaluate the whole close task graph. Processes tasks in declaration order (which
 * is a topological order — dependencies precede dependents), so each task can read
 * the already-computed status of its dependencies.
 *
 * Status semantics:
 *   • pass    — the task is satisfied (auto check ties, or manual is checked off).
 *   • blocked — the task is ACTIONABLE (all dependencies pass) but failing.
 *   • pending — a dependency is not yet passing, so it is not the operator's turn.
 *
 * A satisfied task is always `pass` even if an upstream task is failing (a
 * reconciliation that ties is tied regardless of order).
 */
export function evaluateCloseGraph(
  signals: CloseSignals,
  checkoffs: ManualCheckoffs,
  graph: readonly CloseTaskDef[] = CLOSE_TASK_GRAPH,
): CloseGraphEvaluation {
  const statusByKey = new Map<CloseTaskKey, CloseTaskStatus>();
  const tasks: EvaluatedCloseTask[] = [];

  for (const def of graph) {
    const depsAllPass = def.dependsOn.every((d) => statusByKey.get(d) === 'pass');

    let satisfied: boolean;
    let driverValue: number | null;
    let driverLabel: string;
    let reason: string | null;

    if (def.kind === 'AUTO') {
      const check = evaluateAuto(def.key, signals);
      satisfied = check.satisfied;
      driverValue = check.driverValue;
      driverLabel = check.driverLabel;
      reason = check.reason;
    } else {
      satisfied = checkoffs.has(def.key);
      driverValue = null;
      driverLabel = satisfied ? 'Checked off' : depsAllPass ? 'Awaiting sign-off' : 'Waiting on prerequisites';
      reason = satisfied ? null : `${def.label} has not been signed off`;
    }

    const status: CloseTaskStatus = satisfied ? 'pass' : depsAllPass ? 'blocked' : 'pending';
    statusByKey.set(def.key, status);

    tasks.push({
      ...def,
      status,
      driverValue,
      driverLabel,
      actionable: depsAllPass,
      reason: status === 'pass' ? null : reason,
    });
  }

  const blockers = tasks.filter((t) => t.blocking && t.status !== 'pass');
  const warnings = tasks.filter((t) => !t.blocking && t.status === 'blocked');

  const autoTasks = tasks.filter((t) => t.kind === 'AUTO');
  const manualTasks = tasks.filter((t) => t.kind === 'MANUAL');
  const autoPass = autoTasks.filter((t) => t.status === 'pass').length;
  const manualDone = manualTasks.filter((t) => t.status === 'pass').length;
  const completedTasks = tasks.filter((t) => t.status === 'pass').length;
  const totalTasks = tasks.length;

  return {
    tasks,
    blockers,
    warnings,
    readyToHardClose: blockers.length === 0,
    autoPass,
    autoTotal: autoTasks.length,
    manualDone,
    manualTotal: manualTasks.length,
    completedTasks,
    totalTasks,
    percentComplete: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard-close gate
// ─────────────────────────────────────────────────────────────────────────────

export interface HardCloseBlocker {
  key: CloseTaskKey;
  label: string;
  reason: string;
}

export interface HardCloseGateResult {
  /** May the period transition to HARD_CLOSE? */
  pass: boolean;
  /** Passed only because an authorized override reason was supplied. */
  overridden: boolean;
  /** The blocking tasks that are failing (empty ⇒ clean close). */
  blockers: HardCloseBlocker[];
}

const MIN_OVERRIDE_REASON = 4;

/**
 * The blocking gate. A period may HARD_CLOSE only when every BLOCKING task passes.
 * When one or more blocking tasks fail, the close is refused UNLESS an authorized
 * user supplies an explicit override reason (≥ 4 chars) — which the caller audits
 * alongside the named blockers. This is the single decision the period-close
 * transition consults; it extends (does not duplicate) the bank-reconciliation
 * close gate, which is now one blocking task inside the graph.
 */
export function evaluateHardCloseGate(
  evaluation: CloseGraphEvaluation,
  overrideReason?: string | null,
): HardCloseGateResult {
  const blockers: HardCloseBlocker[] = evaluation.blockers.map((t) => ({
    key: t.key,
    label: t.label,
    reason: t.reason ?? `${t.label} is not complete`,
  }));

  if (blockers.length === 0) {
    return { pass: true, overridden: false, blockers: [] };
  }

  const hasReason = !!overrideReason && overrideReason.trim().length >= MIN_OVERRIDE_REASON;
  return { pass: hasReason, overridden: hasReason, blockers };
}
