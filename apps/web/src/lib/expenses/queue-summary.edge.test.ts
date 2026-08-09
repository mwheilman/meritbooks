import { describe, it, expect } from 'vitest';
import {
  summarizeViolations,
  tallySeverities,
  daysSince,
  type LineViolationsInput,
  type StoredReason,
} from './queue-summary';

// Supplementary EDGE cases (the primary examples live in queue-summary.test.ts).

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

describe('summarizeViolations — ordering within a severity', () => {
  it('orders same-severity groups by count desc, then code asc', () => {
    const s = summarizeViolations([
      line(1, [flag('B_RULE', 'block'), flag('A_RULE', 'block')]),
      line(2, [flag('B_RULE', 'block')]), // B_RULE now tripped twice
    ]);
    // Both BLOCK: B_RULE (count 2) before A_RULE (count 1).
    expect(s.groups.map((g) => g.code)).toEqual(['B_RULE', 'A_RULE']);
    expect(s.blockCount).toBe(3);
  });

  it('breaks a count tie by code ascending', () => {
    const s = summarizeViolations([line(1, [flag('ZED', 'warn'), flag('ALPHA', 'warn')])]);
    expect(s.groups.map((g) => g.code)).toEqual(['ALPHA', 'ZED']);
  });

  it('de-duplicates line numbers when a rule trips twice on one line', () => {
    const s = summarizeViolations([line(4, [flag('DUP', 'warn'), flag('DUP', 'warn')])]);
    const g = s.groups.find((x) => x.code === 'DUP')!;
    expect(g.count).toBe(2);
    expect(g.lineNumbers).toEqual([4]); // one distinct line
  });
});

describe('tallySeverities — resilience', () => {
  it('ignores a non-array line-reasons entry', () => {
    const t = tallySeverities([
      [flag('X', 'block')],
      // @ts-expect-error deliberately malformed row
      null,
      [flag('Y', 'info')],
    ]);
    expect(t).toEqual({ block: 1, warn: 0, info: 1 });
  });
});

describe('daysSince — invalid input', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  it('returns null on an unparseable timestamp', () => {
    expect(daysSince('not-a-date', now)).toBeNull();
    expect(daysSince(undefined, now)).toBeNull();
  });
  it('floors partial days down', () => {
    // 2.9 days earlier → floor to 2
    expect(daysSince('2026-08-06T14:00:00Z', now)).toBe(2);
  });
});
