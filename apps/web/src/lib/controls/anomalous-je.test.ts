/**
 * EC-10 anomalous-JE heuristics — pure-engine assertions.
 *
 * Covers each documented signal in isolation, the ESCALATE/REVIEW/$-materiality
 * routing, that auto-posted (non-manual) entries are never flagged, and that
 * signals stack into an ESCALATE. No I/O — this exercises `assessJournalEntry`.
 */

import { describe, it, expect } from 'vitest';
import {
  assessJournalEntry,
  isSensitiveAccount,
  DEFAULT_ANOMALY_CONFIG,
  type JournalEntryFacts,
  type JeAccountRef,
  type AccountType,
  type AnomalyFlagCode,
} from './anomalous-je';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

const acct = (over: Partial<JeAccountRef> = {}): JeAccountRef => ({
  id: 'acct-opex-1',
  number: '6000',
  name: 'Office Supplies',
  type: 'OPEX' as AccountType,
  subType: 'OPERATING_EXPENSE',
  isControl: false,
  ...over,
});

// A clean, unremarkable manual JE: weekday daytime, same-day posting, mid-month,
// non-round sub-threshold amount, documented, non-sensitive account, low-history
// preparer. 2026-03-16 is a Monday; 15:00 UTC is within business hours.
const base = (over: Partial<JournalEntryFacts> = {}): JournalEntryFacts => ({
  entryId: 'je-1',
  entryNumber: 'JE-000123',
  sourceModule: 'MANUAL',
  entryType: 'STANDARD',
  entryDate: '2026-03-16',
  postedAt: '2026-03-16T15:00:00Z',
  createdAt: '2026-03-16T15:00:00Z',
  memo: 'Reclass office supplies per controller',
  lineMemos: ['office supplies'],
  totalCents: 321_457, // $3,214.57 — non-round, below all thresholds
  isReversing: false,
  reversesEntry: false,
  hasBeenReversed: false,
  accounts: [acct()],
  preparerId: 'user-1',
  preparerEntryCount: 5,
  preparerAccountUsage: { 'acct-opex-1': 5 },
  preparerIsPrivileged: false,
  ...over,
});

const codes = (facts: JournalEntryFacts): AnomalyFlagCode[] =>
  assessJournalEntry(facts, POLICY, DEFAULT_ANOMALY_CONFIG).flags.map((f) => f.code);

describe('clean baseline', () => {
  it('a documented, well-timed, sub-threshold manual JE trips no signals and stays auto', () => {
    const a = assessJournalEntry(base(), POLICY);
    expect(a.flags).toHaveLength(0);
    expect(a.score).toBe(0);
    expect(a.tier).toBe('auto');
  });
});

describe('missing support (the core AU-C 240 signal)', () => {
  it('flags an undocumented manual JE and escalates it above materiality', () => {
    const a = assessJournalEntry(base({ memo: '  ', lineMemos: ['', ''], totalCents: 5_000_000 }), POLICY);
    expect(a.flags.map((f) => f.code)).toContain('MISSING_SUPPORT');
    expect(a.tier).toBe('escalate');
    expect(a.amountAtRiskCents).toBe(5_000_000);
  });

  it('downgrades to review below the $-materiality floor', () => {
    // same missing-support signal, but only $500 at risk → not escalate.
    const a = assessJournalEntry(base({ memo: null, lineMemos: [''], totalCents: 50_000 }), POLICY);
    expect(a.flags.map((f) => f.code)).toContain('MISSING_SUPPORT');
    expect(a.tier).toBe('review');
  });
});

describe('round-dollar above threshold', () => {
  it('flags an exact $5,000 entry', () => {
    expect(codes(base({ totalCents: 500_000 }))).toContain('ROUND_DOLLAR');
  });
  it('does not flag a round amount below the threshold', () => {
    expect(codes(base({ totalCents: 100_000 }))).not.toContain('ROUND_DOLLAR');
  });
  it('does not flag a non-round large amount', () => {
    expect(codes(base({ totalCents: 512_345 }))).not.toContain('ROUND_DOLLAR');
  });
});

describe('structured just under an approval threshold', () => {
  it('flags $9,500 just below the $10,000 gate', () => {
    expect(codes(base({ totalCents: 950_000 }))).toContain('JUST_UNDER_THRESHOLD');
  });
  it('does not flag an amount at or above the threshold', () => {
    expect(codes(base({ totalCents: 1_000_000 }))).not.toContain('JUST_UNDER_THRESHOLD');
  });
});

describe('sensitive accounts', () => {
  it('flags an equity account posted by a non-privileged preparer', () => {
    const a = base({ accounts: [acct({ id: 'eq', name: 'Retained Earnings', type: 'EQUITY', subType: 'EQUITY' })] });
    expect(codes(a)).toContain('SENSITIVE_ACCOUNT');
  });
  it('flags a suspense/clearing account by name', () => {
    const a = base({ accounts: [acct({ id: 'sus', name: 'Suspense - Ask My Accountant', type: 'ASSET' })] });
    expect(codes(a)).toContain('SENSITIVE_ACCOUNT');
  });
  it('does NOT flag when the preparer is authorized for sensitive accounts', () => {
    const a = base({
      accounts: [acct({ id: 'eq', name: 'Owner Equity', type: 'EQUITY', subType: 'EQUITY' })],
      preparerIsPrivileged: true,
    });
    expect(codes(a)).not.toContain('SENSITIVE_ACCOUNT');
  });
  it('isSensitiveAccount: equity / control / named / plain', () => {
    expect(isSensitiveAccount(acct({ type: 'EQUITY' }))).toBe(true);
    expect(isSensitiveAccount(acct({ isControl: true }))).toBe(true);
    expect(isSensitiveAccount(acct({ name: 'Intercompany Due To Fund III' }))).toBe(true);
    expect(isSensitiveAccount(acct({ name: 'Allowance for Doubtful Accounts' }))).toBe(true);
    expect(isSensitiveAccount(acct({ name: 'Office Supplies' }))).toBe(false);
  });
});

describe('unusual account for the preparer', () => {
  it('flags an account the preparer has essentially never used (with enough history)', () => {
    const a = base({
      accounts: [acct({ id: 'rare' })],
      preparerEntryCount: 30,
      preparerAccountUsage: { rare: 1 },
    });
    expect(codes(a)).toContain('UNUSUAL_ACCOUNT_FOR_PREPARER');
  });
  it('does not fire for a low-history preparer (avoids new-preparer noise)', () => {
    const a = base({ accounts: [acct({ id: 'rare' })], preparerEntryCount: 5, preparerAccountUsage: { rare: 1 } });
    expect(codes(a)).not.toContain('UNUSUAL_ACCOUNT_FOR_PREPARER');
  });
  it('does not fire for a routinely-used account', () => {
    const a = base({ accounts: [acct({ id: 'x' })], preparerEntryCount: 30, preparerAccountUsage: { x: 25 } });
    expect(codes(a)).not.toContain('UNUSUAL_ACCOUNT_FOR_PREPARER');
  });
});

describe('timing signals', () => {
  it('flags a weekend posting', () => {
    // 2026-03-14 is a Saturday.
    expect(codes(base({ postedAt: '2026-03-14T15:00:00Z' }))).toContain('AFTER_HOURS_OR_WEEKEND');
  });
  it('flags an after-hours posting', () => {
    expect(codes(base({ postedAt: '2026-03-16T23:30:00Z' }))).toContain('AFTER_HOURS_OR_WEEKEND');
  });
  it('flags a backdated entry', () => {
    // effective 2026-01-31 but keyed 2026-03-16 → ~44 days backdated.
    const a = base({ entryDate: '2026-01-31', postedAt: '2026-03-16T15:00:00Z', createdAt: '2026-03-16T15:00:00Z' });
    expect(codes(a)).toContain('BACKDATED');
  });
  it('flags period-end timing on the last day of the month', () => {
    const a = base({ entryDate: '2026-03-31', postedAt: '2026-03-31T15:00:00Z', createdAt: '2026-03-31T15:00:00Z' });
    expect(codes(a)).toContain('PERIOD_END_TIMING');
  });
});

describe('reversal churn', () => {
  it('flags a reversing entry', () => {
    expect(codes(base({ isReversing: true }))).toContain('REVERSAL_CHURN');
  });
  it('flags an entry that was later reversed', () => {
    expect(codes(base({ hasBeenReversed: true }))).toContain('REVERSAL_CHURN');
  });
});

describe('auto-posted entries are the low-risk surface', () => {
  it('never flags a non-manual entry, even when round + undocumented', () => {
    const a = assessJournalEntry(
      base({ sourceModule: 'BILL', memo: null, lineMemos: [''], totalCents: 5_000_000 }),
      POLICY,
    );
    expect(a.flags).toHaveLength(0);
    expect(a.tier).toBe('auto');
  });
});

describe('signals stack into an ESCALATE', () => {
  it('undocumented + round + sensitive on a material entry escalates', () => {
    const a = assessJournalEntry(
      base({
        memo: null,
        lineMemos: [''],
        totalCents: 5_000_000,
        accounts: [acct({ id: 'eq', name: 'Retained Earnings', type: 'EQUITY', subType: 'EQUITY' })],
      }),
      POLICY,
    );
    const c = a.flags.map((f) => f.code);
    expect(c).toEqual(expect.arrayContaining(['MISSING_SUPPORT', 'ROUND_DOLLAR', 'SENSITIVE_ACCOUNT']));
    expect(a.score).toBeGreaterThanOrEqual(0.7);
    expect(a.tier).toBe('escalate');
  });
});
