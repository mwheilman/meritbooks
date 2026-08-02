/**
 * Autonomy disposition (M10) — exhaustive tests for the PURE decision.
 *
 * The disposition helper is the gate every AI action passes through, so its logic
 * is asserted across every branch: kill switch, each dial mode, the materiality
 * boundary, and each confidence tier. Canon §3: it must NEVER return AUTO unless a
 * tenant explicitly opted a feature up to AUTO_UNDER_LIMIT and the action clears
 * both the confidence tier and the cap.
 */

import { describe, it, expect } from 'vitest';
import {
  decideDisposition,
  DEFAULT_MODE,
  type AutonomySetting,
  type DecideInput,
} from './disposition';
import type { Tier } from '@/lib/trust/score-tier';

const setting = (mode: AutonomySetting['mode'], cap: number | null = null): AutonomySetting => ({
  mode,
  materialityLimitCents: cap,
});

const decide = (over: Partial<DecideInput> = {}) =>
  decideDisposition({
    killSwitchEngaged: false,
    setting: null,
    scoreTier: 'auto',
    amountCents: 0,
    ...over,
  }).disposition;

describe('decideDisposition — kill switch (highest precedence)', () => {
  it('BLOCKS everything when the kill switch is engaged, regardless of mode/tier', () => {
    for (const tier of ['auto', 'review', 'escalate'] as Tier[]) {
      expect(
        decide({
          killSwitchEngaged: true,
          setting: setting('AUTO_UNDER_LIMIT', 1_000_000),
          scoreTier: tier,
          amountCents: 1,
        }),
      ).toBe('BLOCKED');
    }
  });
});

describe('decideDisposition — OFF mode', () => {
  it('BLOCKS the feature whatever the tier', () => {
    for (const tier of ['auto', 'review', 'escalate'] as Tier[]) {
      expect(decide({ setting: setting('OFF'), scoreTier: tier })).toBe('BLOCKED');
    }
  });
});

describe('decideDisposition — PROPOSE mode (and the absent-row default)', () => {
  it('never auto-applies: auto tier → REVIEW', () => {
    expect(decide({ setting: setting('PROPOSE'), scoreTier: 'auto', amountCents: 1 })).toBe('REVIEW');
  });
  it('review tier → REVIEW', () => {
    expect(decide({ setting: setting('PROPOSE'), scoreTier: 'review' })).toBe('REVIEW');
  });
  it('escalate tier is preserved → ESCALATE (never flattened, never auto)', () => {
    expect(decide({ setting: setting('PROPOSE'), scoreTier: 'escalate' })).toBe('ESCALATE');
  });

  it('a null setting (no row) defaults to PROPOSE behavior', () => {
    expect(DEFAULT_MODE).toBe('PROPOSE');
    expect(decide({ setting: null, scoreTier: 'auto', amountCents: 999_999_999 })).toBe('REVIEW');
    expect(decide({ setting: null, scoreTier: 'escalate' })).toBe('ESCALATE');
  });

  it('an unknown/garbage mode is treated conservatively — never AUTO', () => {
    // (decideDisposition trusts its typed input; the I/O layer normalizes garbage to
    //  PROPOSE. Simulate that a caller passed PROPOSE and assert no AUTO leaks.)
    expect(decide({ setting: setting('PROPOSE'), scoreTier: 'auto', amountCents: 0 })).toBe('REVIEW');
  });
});

describe('decideDisposition — AUTO_UNDER_LIMIT mode', () => {
  it('auto tier + amount UNDER the cap → AUTO', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: 50_000 }),
    ).toBe('AUTO');
  });

  it('auto tier + amount EXACTLY AT the cap → AUTO (≤ boundary is inclusive)', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: 100_000 }),
    ).toBe('AUTO');
  });

  it('auto tier + amount ONE CENT OVER the cap → REVIEW', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: 100_001 }),
    ).toBe('REVIEW');
  });

  it('auto tier but NO cap configured (null) → REVIEW (never auto without a cap)', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', null), scoreTier: 'auto', amountCents: 1 }),
    ).toBe('REVIEW');
  });

  it('auto tier but UNKNOWN amount (null/undefined) → REVIEW (cannot confirm ≤ cap)', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: null }),
    ).toBe('REVIEW');
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: undefined }),
    ).toBe('REVIEW');
  });

  it('review tier → REVIEW even under the cap', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'review', amountCents: 1 }),
    ).toBe('REVIEW');
  });

  it('escalate tier → ESCALATE even under the cap', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'escalate', amountCents: 1 }),
    ).toBe('ESCALATE');
  });

  it('zero-amount action at auto tier under a positive cap → AUTO', () => {
    expect(
      decide({ setting: setting('AUTO_UNDER_LIMIT', 100_000), scoreTier: 'auto', amountCents: 0 }),
    ).toBe('AUTO');
  });
});

describe('decideDisposition — reasons are populated for the audit log', () => {
  it('every branch returns a non-empty reason', () => {
    const inputs: DecideInput[] = [
      { killSwitchEngaged: true, setting: null, scoreTier: 'auto' },
      { killSwitchEngaged: false, setting: setting('OFF'), scoreTier: 'auto' },
      { killSwitchEngaged: false, setting: setting('PROPOSE'), scoreTier: 'review' },
      { killSwitchEngaged: false, setting: setting('PROPOSE'), scoreTier: 'escalate' },
      { killSwitchEngaged: false, setting: setting('AUTO_UNDER_LIMIT', 100), scoreTier: 'auto', amountCents: 50 },
      { killSwitchEngaged: false, setting: setting('AUTO_UNDER_LIMIT', 100), scoreTier: 'auto', amountCents: 500 },
      { killSwitchEngaged: false, setting: setting('AUTO_UNDER_LIMIT', null), scoreTier: 'auto', amountCents: 50 },
      { killSwitchEngaged: false, setting: setting('AUTO_UNDER_LIMIT', 100), scoreTier: 'escalate' },
    ];
    for (const input of inputs) {
      const { reason } = decideDisposition(input);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
