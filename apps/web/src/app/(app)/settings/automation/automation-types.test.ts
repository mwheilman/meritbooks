import { describe, expect, it } from 'vitest';
import { emptyHistoryText } from './automation-types';

const base = { consecutiveFailures: 0, lastRunAt: null, lastStatus: null, implemented: true, enabled: true } as const;

describe('emptyHistoryText', () => {
  it('never says "No runs yet" for a job the scheduler recorded failures for', () => {
    const t = emptyHistoryText({ ...base, consecutiveFailures: 3, lastRunAt: new Date(Date.now() - 3_600_000).toISOString(), lastStatus: 'failed' });
    expect(t).not.toMatch(/no runs yet/i);
    expect(t).toMatch(/3 failed attempts in a row/);
  });

  it('a job that ran but whose log aged out says when it last ran', () => {
    const t = emptyHistoryText({ ...base, lastRunAt: new Date(Date.now() - 86_400_000).toISOString(), lastStatus: 'ok' });
    expect(t).toMatch(/^Last ran/);
    expect(t).toMatch(/done/);
  });

  it('only a job that never ran says "No runs yet"', () => {
    expect(emptyHistoryText(base)).toBe('No runs yet.');
    expect(emptyHistoryText({ ...base, enabled: false })).toMatch(/Switched off/);
    expect(emptyHistoryText({ ...base, implemented: false })).toMatch(/Not built/);
  });
});
