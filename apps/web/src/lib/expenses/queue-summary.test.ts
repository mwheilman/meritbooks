import { describe, it, expect } from 'vitest';
import {
  summarizeViolations,
  tallySeverities,
  daysSince,
  agingLabel,
  agingTone,
  isBlocking,
  type LineViolationsInput,
  type StoredReason,
} from './queue-summary';

const flag = (code: string, severity: StoredReason['severity'], message = code): StoredReason => ({
  code,
  message,
  severity,
});

const line = (lineNumber: number, reasons: StoredReason[]): LineViolationsInput => ({
  lineNumber,
  merchant: `m${lineNumber}`,
  description: null,
  amountCents: 1000,
  reasons,
});

describe('summarizeViolations', () => {
  it('returns an empty summary when nothing is flagged', () => {
    const s = summarizeViolations([line(1, []), line(2, [])]);
    expect(s).toEqual({ blockCount: 0, warnCount: 0, infoCount: 0, flaggedLineCount: 0, groups: [] });
  });

  it('counts severities and flagged lines', () => {
    const s = summarizeViolations([
      line(1, [flag('ABSOLUTE_CEILING', 'block'), flag('WEEKEND_EXPENSE', 'info')]),
      line(2, [flag('RECEIPT_REQUIRED', 'warn')]),
      line(3, []),
    ]);
    expect(s.blockCount).toBe(1);
    expect(s.warnCount).toBe(1);
    expect(s.infoCount).toBe(1);
    expect(s.flaggedLineCount).toBe(2);
  });

  it('groups the same rule across lines and records line numbers ascending', () => {
    const s = summarizeViolations([
      line(3, [flag('RECEIPT_REQUIRED', 'warn')]),
      line(1, [flag('RECEIPT_REQUIRED', 'warn')]),
    ]);
    const g = s.groups.find((x) => x.code === 'RECEIPT_REQUIRED')!;
    expect(g.count).toBe(2);
    expect(g.lineNumbers).toEqual([1, 3]);
  });

  it('orders groups BLOCK before WARN before INFO', () => {
    const s = summarizeViolations([
      line(1, [flag('WEEKEND_EXPENSE', 'info'), flag('RECEIPT_REQUIRED', 'warn'), flag('ABSOLUTE_CEILING', 'block')]),
    ]);
    expect(s.groups.map((g) => g.severity)).toEqual(['block', 'warn', 'info']);
  });

  it('is deterministic for identical input', () => {
    const input = [line(1, [flag('A', 'block'), flag('B', 'warn')]), line(2, [flag('A', 'block')])];
    expect(summarizeViolations(input)).toEqual(summarizeViolations(input));
  });
});

describe('tallySeverities', () => {
  it('sums across a report’s lines', () => {
    const t = tallySeverities([
      [flag('X', 'block'), flag('Y', 'warn')],
      [flag('Z', 'info')],
      [],
    ]);
    expect(t).toEqual({ block: 1, warn: 1, info: 1 });
  });
});

describe('daysSince / agingLabel / agingTone', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  it('computes whole days and clamps negatives to 0', () => {
    expect(daysSince('2026-08-06T12:00:00Z', now)).toBe(3);
    expect(daysSince('2026-08-09T12:00:00Z', now)).toBe(0);
    expect(daysSince('2026-08-20T00:00:00Z', now)).toBe(0); // future → 0
    expect(daysSince(null, now)).toBeNull();
  });
  it('labels aging compactly', () => {
    expect(agingLabel(null)).toBe('—');
    expect(agingLabel(0)).toBe('today');
    expect(agingLabel(1)).toBe('1 day');
    expect(agingLabel(5)).toBe('5 days');
  });
  it('buckets aging into tones', () => {
    expect(agingTone(0)).toBe('fresh');
    expect(agingTone(3)).toBe('aging');
    expect(agingTone(7)).toBe('stale');
    expect(agingTone(null)).toBe('fresh');
  });
});

describe('isBlocking', () => {
  it('is true only for block severity', () => {
    expect(isBlocking('block')).toBe(true);
    expect(isBlocking('warn')).toBe(false);
    expect(isBlocking('info')).toBe(false);
  });
});
