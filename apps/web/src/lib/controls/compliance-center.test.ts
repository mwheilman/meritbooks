/**
 * Compliance Command Center — pure aggregation + SoD-violation detection.
 *
 * Proves the read-only shaping is correct against fixed fixtures:
 *   - exception aggregation: open vs cleared vs rejected, $-exposure (open only),
 *     escalate detection (ESCALATE disposition / money-already-out / payment BLOCK),
 *     and the pass/warn/fail status each control derives.
 *   - SoD detection: positive dual-control evidence AND both violation classes
 *     (approver==preparer, releaser==preparer).
 *   - autonomy posture: every catalog feature present once; AUTO/kill-switch → warn.
 *   - audit completeness: empty trail is a control gap (warn).
 *   - end-to-end assembly: worst-of overall + summary rollups.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateExceptions,
  statusFromException,
  isCriticalOpen,
  buildControlCards,
  detectSodViolations,
  buildAutonomyPosture,
  assessAuditCompleteness,
  assembleComplianceCenter,
  type ExceptionRow,
  type ApprovalRow,
  type LoadedAutonomySetting,
  type AuditActionRow,
} from './compliance-center';
import { AUTONOMY_FEATURES } from '@/lib/autonomy/catalog';

// ── fixtures ──────────────────────────────────────────────────────────────────

function ex(over: Partial<ExceptionRow>): ExceptionRow {
  return {
    feature: 'DUPLICATE_PAYMENT',
    status: 'PROPOSED',
    confidence: 0.9,
    amountAtRiskCents: 100_00,
    disposition: 'REVIEW',
    moneyAlreadyOut: false,
    level: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function appr(over: Partial<ApprovalRow>): ApprovalRow {
  return {
    id: 'a1',
    kind: 'AP_DISBURSEMENT',
    status: 'RELEASED',
    amountCents: 500_00,
    preparedBy: 'user_prep',
    approvedBy: 'user_appr',
    releasedBy: 'user_rel',
    ...over,
  };
}

// ── exception aggregation ─────────────────────────────────────────────────────

describe('aggregateExceptions', () => {
  it('separates open / cleared / rejected and sums exposure for open only', () => {
    const rows = [
      ex({ status: 'PROPOSED', amountAtRiskCents: 100_00 }),
      ex({ status: 'PROPOSED', amountAtRiskCents: 250_00 }),
      ex({ status: 'APPROVED', amountAtRiskCents: 999_00 }), // cleared → not exposure
      ex({ status: 'REJECTED', amountAtRiskCents: 999_00 }), // rejected → not exposure
    ];
    const agg = aggregateExceptions(rows).get('DUPLICATE_PAYMENT')!;
    expect(agg.open).toBe(2);
    expect(agg.cleared).toBe(1);
    expect(agg.rejected).toBe(1);
    expect(agg.exposureCents).toBe(350_00);
  });

  it('counts an escalated / money-out / BLOCK open row as critical', () => {
    expect(isCriticalOpen(ex({ disposition: 'ESCALATE' }))).toBe(true);
    expect(isCriticalOpen(ex({ moneyAlreadyOut: true }))).toBe(true);
    expect(isCriticalOpen(ex({ feature: 'PAYMENT_FRAUD', level: 'block' }))).toBe(true);
    // cleared rows never count as critical even if flagged
    expect(isCriticalOpen(ex({ status: 'APPROVED', disposition: 'ESCALATE' }))).toBe(false);
    expect(isCriticalOpen(ex({ disposition: 'REVIEW' }))).toBe(false);
  });

  it('status: pass when no open, warn when open, fail when escalated', () => {
    expect(statusFromException(undefined)).toBe('pass');
    const passAgg = aggregateExceptions([ex({ status: 'APPROVED' })]).get('DUPLICATE_PAYMENT');
    expect(statusFromException(passAgg)).toBe('pass');
    const warnAgg = aggregateExceptions([ex({ status: 'PROPOSED', disposition: 'REVIEW' })]).get('DUPLICATE_PAYMENT');
    expect(statusFromException(warnAgg)).toBe('warn');
    const failAgg = aggregateExceptions([ex({ status: 'PROPOSED', moneyAlreadyOut: true })]).get('DUPLICATE_PAYMENT');
    expect(statusFromException(failAgg)).toBe('fail');
  });

  it('treats a null/negative exposure as zero (never subtracts)', () => {
    const agg = aggregateExceptions([
      ex({ amountAtRiskCents: null }),
      ex({ amountAtRiskCents: -50_00 }),
    ]).get('DUPLICATE_PAYMENT')!;
    expect(agg.exposureCents).toBe(0);
  });
});

describe('buildControlCards', () => {
  it('produces one card per control feature with derived status + detail', () => {
    const agg = aggregateExceptions([
      ex({ feature: 'DUPLICATE_PAYMENT', status: 'PROPOSED', moneyAlreadyOut: true, amountAtRiskCents: 300_00 }),
      ex({ feature: 'ANOMALOUS_JE', status: 'APPROVED' }),
    ]);
    const cards = buildControlCards(agg);
    const dup = cards.find((c) => c.feature === 'DUPLICATE_PAYMENT')!;
    const je = cards.find((c) => c.feature === 'ANOMALOUS_JE')!;
    const cutoff = cards.find((c) => c.feature === 'CUTOFF_ERROR')!;

    expect(dup.id).toBe('EC-1');
    expect(dup.status).toBe('fail');
    expect(dup.escalateCount).toBe(1);
    expect(dup.exposureCents).toBe(300_00);

    expect(je.status).toBe('pass'); // only a cleared row
    expect(je.clearedCount).toBe(1);

    expect(cutoff.status).toBe('pass'); // no rows at all
    expect(cutoff.openCount).toBe(0);

    // PAYMENT_FRAUD is a control even though it is not in the autonomy catalog.
    expect(cards.some((c) => c.feature === 'PAYMENT_FRAUD')).toBe(true);
  });
});

// ── SoD detection ─────────────────────────────────────────────────────────────

describe('detectSodViolations', () => {
  it('tallies positive dual-control evidence when approver != preparer', () => {
    const ev = detectSodViolations([
      appr({ preparedBy: 'p', approvedBy: 'q', releasedBy: 'r' }),
      appr({ id: 'a2', preparedBy: 'p', approvedBy: 'q', releasedBy: null, status: 'APPROVED' }),
    ]);
    expect(ev.evaluated).toBe(2);
    expect(ev.withApprover).toBe(2);
    expect(ev.sodSatisfied).toBe(2);
    expect(ev.released).toBe(1);
    expect(ev.violations).toHaveLength(0);
    expect(ev.status).toBe('pass');
  });

  it('flags APPROVER_EQ_PREPARER as a fail', () => {
    const ev = detectSodViolations([appr({ preparedBy: 'same', approvedBy: 'same' })]);
    expect(ev.violations).toHaveLength(1);
    expect(ev.violations[0].type).toBe('APPROVER_EQ_PREPARER');
    expect(ev.sodSatisfied).toBe(0);
    expect(ev.status).toBe('fail');
  });

  it('flags RELEASER_EQ_PREPARER as a fail even when approval was clean', () => {
    const ev = detectSodViolations([appr({ preparedBy: 'p', approvedBy: 'q', releasedBy: 'p' })]);
    expect(ev.violations).toHaveLength(1);
    expect(ev.violations[0].type).toBe('RELEASER_EQ_PREPARER');
    expect(ev.sodSatisfied).toBe(1); // approval leg was still segregated
    expect(ev.status).toBe('fail');
  });

  it('warns when movements exist but none has reached an approver yet', () => {
    const ev = detectSodViolations([
      appr({ status: 'PENDING_APPROVAL', approvedBy: null, releasedBy: null }),
    ]);
    expect(ev.withApprover).toBe(0);
    expect(ev.violations).toHaveLength(0);
    expect(ev.status).toBe('warn');
  });

  it('passes cleanly with no money movements at all', () => {
    const ev = detectSodViolations([]);
    expect(ev.status).toBe('pass');
    expect(ev.evaluated).toBe(0);
  });
});

// ── autonomy posture ──────────────────────────────────────────────────────────

describe('buildAutonomyPosture', () => {
  it('lists every catalog feature exactly once, defaulting to PROPOSE', () => {
    const posture = buildAutonomyPosture([], false);
    expect(posture.items).toHaveLength(AUTONOMY_FEATURES.length);
    expect(posture.items.every((i) => i.isDefault && i.mode === 'PROPOSE')).toBe(true);
    expect(posture.status).toBe('pass');
  });

  it('warns when any feature is dialed to AUTO_UNDER_LIMIT', () => {
    const settings: LoadedAutonomySetting[] = [
      { feature: 'CATEGORIZATION', mode: 'AUTO_UNDER_LIMIT', materialityLimitCents: 10_000_00 },
    ];
    const posture = buildAutonomyPosture(settings, false);
    expect(posture.autoEnabledCount).toBe(1);
    expect(posture.status).toBe('warn');
    const cat = posture.items.find((i) => i.feature === 'CATEGORIZATION')!;
    expect(cat.isDefault).toBe(false);
    expect(cat.materialityLimitCents).toBe(10_000_00);
  });

  it('warns when the global kill switch is engaged', () => {
    const posture = buildAutonomyPosture([], true);
    expect(posture.killSwitchEngaged).toBe(true);
    expect(posture.status).toBe('warn');
  });
});

// ── audit completeness ────────────────────────────────────────────────────────

describe('assessAuditCompleteness', () => {
  it('warns on an empty trail (a control gap)', () => {
    const a = assessAuditCompleteness([]);
    expect(a.status).toBe('warn');
    expect(a.totalActions).toBe(0);
  });

  it('passes a populated trail and attributes by actor + last timestamp', () => {
    const rows: AuditActionRow[] = [
      { actorType: 'HUMAN', createdAt: '2026-08-01T10:00:00Z' },
      { actorType: 'AI', createdAt: '2026-08-02T10:00:00Z' },
      { actorType: 'AI', createdAt: '2026-08-01T09:00:00Z' },
      { actorType: 'SYSTEM', createdAt: '2026-07-31T10:00:00Z' },
    ];
    const a = assessAuditCompleteness(rows);
    expect(a.status).toBe('pass');
    expect(a.totalActions).toBe(4);
    expect(a.byActor).toEqual({ HUMAN: 1, AI: 2, SYSTEM: 1 });
    expect(a.lastActionAt).toBe('2026-08-02T10:00:00Z');
  });
});

// ── end-to-end assembly ───────────────────────────────────────────────────────

describe('assembleComplianceCenter', () => {
  it('rolls up summary counts and takes the worst-of overall status', () => {
    const center = assembleComplianceCenter({
      exceptions: [
        ex({ feature: 'DUPLICATE_PAYMENT', status: 'PROPOSED', moneyAlreadyOut: true, amountAtRiskCents: 200_00 }),
        ex({ feature: 'UNCATEGORIZED_LEAKAGE', status: 'PROPOSED', disposition: 'REVIEW', amountAtRiskCents: 40_00 }),
      ],
      approvals: [appr({ preparedBy: 'p', approvedBy: 'q', releasedBy: 'r' })],
      autonomySettings: [],
      killSwitchEngaged: false,
      auditActions: [{ actorType: 'AI', createdAt: '2026-08-01T00:00:00Z' }],
      now: '2026-08-02T00:00:00.000Z',
    });

    expect(center.summary.overall).toBe('fail'); // duplicate payment escalated
    expect(center.summary.openExceptions).toBe(2);
    expect(center.summary.totalExposureCents).toBe(240_00);
    expect(center.summary.fail).toBeGreaterThanOrEqual(1);
    expect(center.exceptionsByClass.length).toBe(center.controls.length);
    expect(center.generatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(center.hrefs.exceptions).toBe('/exceptions');
  });

  it('reports pass overall when nothing is open and controls are conservative', () => {
    const center = assembleComplianceCenter({
      exceptions: [ex({ status: 'APPROVED' })],
      approvals: [appr({ preparedBy: 'p', approvedBy: 'q', releasedBy: 'r' })],
      autonomySettings: [],
      killSwitchEngaged: false,
      auditActions: [{ actorType: 'HUMAN', createdAt: '2026-08-01T00:00:00Z' }],
    });
    expect(center.summary.overall).toBe('pass');
    expect(center.summary.openExceptions).toBe(0);
  });
});
