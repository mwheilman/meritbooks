/**
 * Reconciliation memo fact-sheet + deterministic fallback (FPB Bank Reconciliation,
 * Wave B). Proves the memo phrases ONLY supplied figures and never implies a plug
 * was posted, and that override + stale items are documented.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMemoFacts,
  deterministicMemo,
  memoUserPrompt,
  type ReconMemoFacts,
} from './reconciliation-memo';

const facts = (over: Partial<ReconMemoFacts>): ReconMemoFacts => ({
  accountName: 'Operating',
  accountMask: '4321',
  locationName: 'HQ',
  periodLabel: 'Jan 2026',
  statementDate: '2026-01-31',
  beginningBalanceCents: 100_000_00,
  statementEndingBalanceCents: 120_000_00,
  glCashBalanceCents: 120_000_00,
  clearedDepositsCents: 30_000_00,
  clearedPaymentsCents: 10_000_00,
  clearedNetCents: 20_000_00,
  clearedBalanceCents: 120_000_00,
  clearedCount: 12,
  outstandingCount: 3,
  differenceCents: 0,
  ties: true,
  plugCents: 0,
  staleCount: 0,
  staleOutstandingChecksCents: 0,
  staleDepositsInTransitCents: 0,
  staleThresholdDays: 30,
  finalized: false,
  overridden: false,
  overrideReason: null,
  ...over,
});

describe('buildMemoFacts', () => {
  it('states a tie plainly', () => {
    const out = buildMemoFacts(facts({}));
    expect(out).toContain('TIES');
    expect(out).toContain('Beginning balance:');
  });

  it('surfaces a plug without implying it was posted', () => {
    const out = buildMemoFacts(facts({ ties: false, differenceCents: -5_00, plugCents: -5_00 }));
    expect(out).toContain('DOES NOT TIE');
    expect(out).toContain('surfaced, not posted');
  });

  it('documents stale items and an override', () => {
    const out = buildMemoFacts(
      facts({
        staleCount: 2,
        staleOutstandingChecksCents: 500_00,
        finalized: true,
        overridden: true,
        overrideReason: 'Immaterial timing difference, cleared next month',
      }),
    );
    expect(out).toContain('Stale reconciling items');
    expect(out).toContain('AUTHORIZED OVERRIDE');
    expect(out).toContain('Immaterial timing difference');
  });
});

describe('deterministicMemo', () => {
  it('produces a truthful tie memo', () => {
    const out = deterministicMemo(facts({}));
    expect(out).toContain('ties to the statement');
    expect(out).toContain('Operating');
  });

  it('never claims a non-zero plug was posted', () => {
    const out = deterministicMemo(facts({ ties: false, plugCents: 7_50, differenceCents: 7_50 }));
    expect(out).toContain('not posted');
    expect(out.toLowerCase()).not.toContain('forced to $0');
  });
});

describe('memoUserPrompt', () => {
  it('wraps facts with a phrase-only instruction', () => {
    const p = memoUserPrompt('SOME FACTS');
    expect(p).toContain('SOME FACTS');
    expect(p).toContain('do not alter any number');
  });
});
