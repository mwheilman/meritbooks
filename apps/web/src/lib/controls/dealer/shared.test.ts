import { describe, expect, it } from 'vitest';
import { normalizeToken, planPersistence, tierForSeverity, type DealerFinding, type ExistingDecision } from './shared';

const f = (key: string, over: Partial<DealerFinding> = {}): DealerFinding => ({
  control: 'DL-2', kind: 'due', dedupKey: key, severity: 'MEDIUM', amountAtRiskCents: 100, title: `t ${key}`, reason: 'r', question: 'q',
  href: '/dealer', subjects: {}, subjectTable: 't', subjectId: null, ...over,
});
const ex = (key: string, status: ExistingDecision['status'], over: Partial<ExistingDecision> = {}): ExistingDecision => ({
  id: `row-${key}-${status}`, status, location_id: 'L1', input_summary: `t ${key}`, confidence: 1, dedupKey: key, amount: 100, severity: 'MEDIUM', ...over,
});

describe('tierForSeverity', () => {
  it('escalates CRITICAL / HIGH, reviews MEDIUM / LOW', () => {
    expect(tierForSeverity('CRITICAL')).toBe('escalate');
    expect(tierForSeverity('HIGH')).toBe('escalate');
    expect(tierForSeverity('MEDIUM')).toBe('review');
    expect(tierForSeverity('LOW')).toBe('review');
  });
});

describe('normalizeToken', () => {
  it('upper-cases and strips everything but letters and digits', () => {
    expect(normalizeToken(' ab-12 34/x ')).toBe('AB1234X');
    expect(normalizeToken(null)).toBe('');
  });
});

describe('planPersistence', () => {
  const scanned = new Set(['L1']);
  it('inserts new keys once, even if a detector repeats one', () => {
    const p = planPersistence([{ locationId: 'L1', finding: f('a') }, { locationId: 'L1', finding: f('a') }], [], scanned);
    expect(p.insert.map((x) => x.dedupKey)).toEqual(['a']);
  });
  it('does not re-insert an open key; refreshes only when the title / amount / severity changed', () => {
    const same = planPersistence([{ locationId: 'L1', finding: f('a') }], [ex('a', 'PROPOSED')], scanned);
    expect(same.insert).toHaveLength(0);
    expect(same.refresh).toHaveLength(0);
    const moved = planPersistence([{ locationId: 'L1', finding: f('a', { amountAtRiskCents: 250 }) }], [ex('a', 'PROPOSED')], scanned);
    expect(moved.refresh.map((x) => x.id)).toEqual(['row-a-PROPOSED']);
  });
  it('suppresses a key a person already resolved', () => {
    for (const st of ['APPROVED', 'REJECTED'] as const) {
      const p = planPersistence([{ locationId: 'L1', finding: f('a') }], [ex('a', st)], scanned);
      expect(p.insert).toHaveLength(0);
      expect(p.suppressed).toBe(1);
    }
  });
  it('expires open rows whose condition cleared — only for clients scanned this run', () => {
    const p = planPersistence([], [ex('a', 'PROPOSED'), ex('b', 'PROPOSED', { location_id: 'L2' }), ex('c', 'REJECTED')], scanned);
    expect(p.expire).toEqual(['row-a-PROPOSED']);
  });
});
