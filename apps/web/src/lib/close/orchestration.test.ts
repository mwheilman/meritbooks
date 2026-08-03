import { describe, it, expect } from 'vitest';
import {
  CLOSE_TASK_GRAPH,
  MANUAL_TASK_KEYS,
  AUTO_TASK_KEYS,
  evaluateCloseGraph,
  evaluateHardCloseGate,
  isManualTaskKey,
  getCloseTask,
  type CloseSignals,
  type CloseTaskKey,
} from './orchestration';

// A set of live signals where every AUTO check TIES (all green).
const CLEAN_SIGNALS: CloseSignals = {
  uncodedBankCents: 0,
  reconciliationBlockers: 0,
  arVarianceCents: 0,
  apVarianceCents: 0,
  blockingLeakageCents: 0,
  leakageItems: 0,
  openExceptions: 0,
};

const ALL_MANUAL = new Set<CloseTaskKey>(MANUAL_TASK_KEYS);

function statusOf(evaluation: ReturnType<typeof evaluateCloseGraph>, key: CloseTaskKey) {
  return evaluation.tasks.find((t) => t.key === key)!.status;
}

describe('close task graph — shape & topological ordering', () => {
  it('every dependency appears earlier in the array (topological order)', () => {
    const seen = new Set<CloseTaskKey>();
    for (const task of CLOSE_TASK_GRAPH) {
      for (const dep of task.dependsOn) {
        expect(seen.has(dep), `${task.key} depends on ${dep} which must precede it`).toBe(true);
      }
      seen.add(task.key);
    }
  });

  it('references no unknown dependency keys', () => {
    const keys = new Set(CLOSE_TASK_GRAPH.map((t) => t.key));
    for (const task of CLOSE_TASK_GRAPH) {
      for (const dep of task.dependsOn) expect(keys.has(dep)).toBe(true);
    }
  });

  it('splits into auto and manual task sets that cover the graph', () => {
    expect(AUTO_TASK_KEYS.length + MANUAL_TASK_KEYS.length).toBe(CLOSE_TASK_GRAPH.length);
    expect(new Set([...AUTO_TASK_KEYS, ...MANUAL_TASK_KEYS]).size).toBe(CLOSE_TASK_GRAPH.length);
  });

  it('isManualTaskKey narrows only the manual keys', () => {
    expect(isManualTaskKey('accruals_posted')).toBe(true);
    expect(isManualTaskKey('reconciliations_tied')).toBe(false);
    expect(isManualTaskKey('not_a_task')).toBe(false);
  });

  it('getCloseTask returns the definition for a key', () => {
    expect(getCloseTask('reviewed').kind).toBe('MANUAL');
    expect(getCloseTask('bank_feeds_imported').blocking).toBe(true);
  });
});

describe('evaluateCloseGraph — auto verification', () => {
  it('all auto checks tie + all manual signed off ⇒ every task passes, ready to close', () => {
    const ev = evaluateCloseGraph(CLEAN_SIGNALS, ALL_MANUAL);
    expect(ev.tasks.every((t) => t.status === 'pass')).toBe(true);
    expect(ev.readyToHardClose).toBe(true);
    expect(ev.blockers).toHaveLength(0);
    expect(ev.percentComplete).toBe(100);
    expect(ev.completedTasks).toBe(ev.totalTasks);
  });

  it('a failing FOUNDATION auto task blocks it and leaves not-yet-tied dependents pending (dependency ordering)', () => {
    // Bank feeds are not coded (foundation fails). The downstream ties have ALSO
    // not been achieved (reconciliation carries a blocker, AR shows a variance),
    // so they are genuinely not the operator's turn. (An independently-tied task
    // would pass regardless of upstream — that "satisfied wins" case is covered
    // by the next test.)
    const signals: CloseSignals = {
      ...CLEAN_SIGNALS,
      uncodedBankCents: 500_00,
      reconciliationBlockers: 1,
      arVarianceCents: 250_00,
    };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);

    // bank feeds is actionable (no deps) and failing ⇒ blocked, with the driving $.
    expect(statusOf(ev, 'bank_feeds_imported')).toBe('blocked');
    const bank = ev.tasks.find((t) => t.key === 'bank_feeds_imported')!;
    expect(bank.driverValue).toBe(500_00);
    expect(bank.reason).toMatch(/not yet coded/i);

    // reconciliations depend on bank feeds and do not tie ⇒ not the operator's
    // turn ⇒ pending. AR depends on reconciliations and likewise stays pending.
    expect(statusOf(ev, 'reconciliations_tied')).toBe('pending');
    expect(statusOf(ev, 'ar_subledger_tie')).toBe('pending');
    expect(ev.readyToHardClose).toBe(false);
  });

  it('a satisfied task shows pass even if an UPSTREAM task is failing', () => {
    // reconciliation ties, but bank feeds are not coded (upstream failing).
    const signals: CloseSignals = { ...CLEAN_SIGNALS, uncodedBankCents: 100_00, reconciliationBlockers: 0 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    // The rule: a genuinely-satisfied task is 'pass' regardless of upstream. But
    // reconciliations_tied has an unmet dependency AND ties, so per the "satisfied
    // wins" rule it passes.
    expect(statusOf(ev, 'reconciliations_tied')).toBe('pass');
    expect(statusOf(ev, 'bank_feeds_imported')).toBe('blocked');
  });

  it('AR/AP variance is reported and blocks the tie tasks', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, arVarianceCents: 250, apVarianceCents: 0 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    expect(statusOf(ev, 'ar_subledger_tie')).toBe('blocked');
    expect(statusOf(ev, 'ap_subledger_tie')).toBe('pass');
    const ar = ev.tasks.find((t) => t.key === 'ar_subledger_tie')!;
    expect(ar.driverValue).toBe(250);
  });

  it('a null AR control (unmapped) fails closed with a clear reason', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, arVarianceCents: null };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    const ar = ev.tasks.find((t) => t.key === 'ar_subledger_tie')!;
    expect(ar.status).toBe('blocked');
    expect(ar.driverValue).toBeNull();
    expect(ar.reason).toMatch(/not mapped/i);
    expect(ev.readyToHardClose).toBe(false);
  });

  it('open review-queue exceptions are a NON-blocking warning (do not stop the close)', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, openExceptions: 3 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    expect(statusOf(ev, 'exceptions_cleared')).toBe('blocked');
    expect(ev.warnings.map((w) => w.key)).toContain('exceptions_cleared');
    // Not a blocker ⇒ the close is still ready.
    expect(ev.blockers.map((b) => b.key)).not.toContain('exceptions_cleared');
    expect(ev.readyToHardClose).toBe(true);
  });

  it('non-material (sub-escalate) leakage still passes uncategorized_cleared', () => {
    // blockingLeakageCents is the escalate-tier amount; items present but immaterial.
    const signals: CloseSignals = { ...CLEAN_SIGNALS, blockingLeakageCents: 0, leakageItems: 4 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    expect(statusOf(ev, 'uncategorized_cleared')).toBe('pass');
    const t = ev.tasks.find((x) => x.key === 'uncategorized_cleared')!;
    expect(t.driverLabel).toMatch(/none material/i);
  });

  it('material leakage blocks uncategorized_cleared', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, blockingLeakageCents: 30_000_00, leakageItems: 2 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    expect(statusOf(ev, 'uncategorized_cleared')).toBe('blocked');
    expect(ev.blockers.map((b) => b.key)).toContain('uncategorized_cleared');
  });
});

describe('evaluateCloseGraph — manual sign-offs', () => {
  it('unchecked manual tasks are blocked once their auto prerequisites pass', () => {
    const ev = evaluateCloseGraph(CLEAN_SIGNALS, new Set<CloseTaskKey>());
    // ties are all green so accruals/prepaids/depreciation are actionable but unsigned.
    expect(statusOf(ev, 'accruals_posted')).toBe('blocked');
    expect(statusOf(ev, 'prepaids_posted')).toBe('blocked');
    expect(statusOf(ev, 'depreciation_posted')).toBe('blocked');
    // reviewed depends on the three above ⇒ pending until they're signed.
    expect(statusOf(ev, 'reviewed')).toBe('pending');
    expect(ev.readyToHardClose).toBe(false);
    expect(ev.manualDone).toBe(0);
  });

  it('manual tasks are PENDING (not blocked) while their auto prerequisites fail', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, arVarianceCents: 999 };
    const ev = evaluateCloseGraph(signals, new Set<CloseTaskKey>());
    // accruals depend on the AR/AP tie; AR is failing ⇒ accruals not actionable.
    expect(statusOf(ev, 'accruals_posted')).toBe('pending');
    expect(ev.tasks.find((t) => t.key === 'accruals_posted')!.actionable).toBe(false);
  });

  it('signing off the final review only passes when all its prerequisites pass', () => {
    // Everything auto ties; sign off accruals/prepaids/depreciation + reviewed.
    const ev = evaluateCloseGraph(CLEAN_SIGNALS, ALL_MANUAL);
    expect(statusOf(ev, 'reviewed')).toBe('pass');
  });
});

describe('evaluateHardCloseGate', () => {
  it('passes cleanly when every blocking task passes', () => {
    const ev = evaluateCloseGraph(CLEAN_SIGNALS, ALL_MANUAL);
    const gate = evaluateHardCloseGate(ev, null);
    expect(gate.pass).toBe(true);
    expect(gate.overridden).toBe(false);
    expect(gate.blockers).toHaveLength(0);
  });

  it('BLOCKS when a blocking task fails, and surfaces which one', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, reconciliationBlockers: 2 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    const gate = evaluateHardCloseGate(ev, null);
    expect(gate.pass).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toContain('reconciliations_tied');
    expect(gate.blockers[0].reason).toMatch(/unreconciled|variance/i);
  });

  it('does NOT block for a purely non-blocking failure (open exceptions only)', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, openExceptions: 5 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    const gate = evaluateHardCloseGate(ev, null);
    expect(gate.pass).toBe(true);
    expect(gate.blockers).toHaveLength(0);
  });

  it('an unchecked manual blocking task blocks the gate', () => {
    const ev = evaluateCloseGraph(CLEAN_SIGNALS, new Set<CloseTaskKey>());
    const gate = evaluateHardCloseGate(ev, null);
    expect(gate.pass).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toEqual(
      expect.arrayContaining(['accruals_posted', 'prepaids_posted', 'depreciation_posted', 'reviewed']),
    );
  });

  it('an authorized override reason bypasses the blockers (audited by the caller)', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, reconciliationBlockers: 1, arVarianceCents: 500 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    const gate = evaluateHardCloseGate(ev, 'Board-approved close with adjustment tracked to Q3');
    expect(gate.pass).toBe(true);
    expect(gate.overridden).toBe(true);
    // The bypassed blockers are still reported so the override can be audited.
    expect(gate.blockers.length).toBeGreaterThan(0);
  });

  it('a too-short override reason does NOT bypass the gate', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, reconciliationBlockers: 1 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    const gate = evaluateHardCloseGate(ev, 'x');
    expect(gate.pass).toBe(false);
    expect(gate.overridden).toBe(false);
  });

  it('an empty/whitespace override reason does NOT bypass the gate', () => {
    const signals: CloseSignals = { ...CLEAN_SIGNALS, reconciliationBlockers: 1 };
    const ev = evaluateCloseGraph(signals, ALL_MANUAL);
    expect(evaluateHardCloseGate(ev, '   ').pass).toBe(false);
    expect(evaluateHardCloseGate(ev, null).pass).toBe(false);
    expect(evaluateHardCloseGate(ev, undefined).pass).toBe(false);
  });
});
