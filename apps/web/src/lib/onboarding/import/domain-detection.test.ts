/**
 * Unit tests for the long-tail domain detection + hint helpers (Setup Home board).
 * Pure derivation (done / detected / add-later) + the detected-hint setter's
 * read-merge-write (must preserve other flags/section keys).
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OnboardingStatus } from '@/lib/onboarding/status';
import {
  deriveDomainBoardStatus,
  deriveDomainSectionStatus,
  readDomainHint,
  setDomainDetectedHint,
} from './domain-detection';

// A minimal OnboardingStatus with a section map + counts we can shape per test.
function statusWith(
  sections: Record<string, { status: string; proposalId?: string }>,
  counts: Partial<Record<string, number>> = {},
): OnboardingStatus {
  return {
    firstRun: false,
    complete: true,
    currentStep: 'launch',
    counts: { entities: 1, accounts: 1, teamMembers: 1, glEntries: 1, bankAccounts: 0, categorizedTransactions: 0, ...counts } as OnboardingStatus['counts'],
    hasOpeningEntry: true,
    setupComplete: true,
    statePersisted: true,
    flag: null,
    sections: sections as unknown as OnboardingStatus['sections'],
  };
}

describe('deriveDomainBoardStatus (done / detected / add-later)', () => {
  it('live rows ⇒ done, and done wins over a detected hint', () => {
    expect(deriveDomainBoardStatus({ liveCount: 2 })).toBe('done');
    expect(deriveDomainBoardStatus({ liveCount: 2, detected: true })).toBe('done');
  });

  it('a detected import (no rows yet) ⇒ detected', () => {
    expect(deriveDomainBoardStatus({ detected: true })).toBe('detected');
  });

  it('nothing yet ⇒ the neutral add-later (never a red nag)', () => {
    expect(deriveDomainBoardStatus({})).toBe('add-later');
    expect(deriveDomainBoardStatus({ liveCount: 0, detected: false })).toBe('add-later');
    expect(deriveDomainBoardStatus({ markedNotApplicable: true })).toBe('add-later');
  });
});

describe('deriveDomainSectionStatus (SectionDefinition lifecycle)', () => {
  it('maps every disposition (done / n_a / skipped / detected / not_started)', () => {
    expect(deriveDomainSectionStatus({ liveCount: 1 })).toBe('done');
    expect(deriveDomainSectionStatus({ markedNotApplicable: true })).toBe('n_a');
    expect(deriveDomainSectionStatus({ skipped: true })).toBe('skipped');
    expect(deriveDomainSectionStatus({ detected: true })).toBe('in_progress');
    expect(deriveDomainSectionStatus({})).toBe('not_started');
  });

  it('a live count wins over any lingering disposition', () => {
    expect(deriveDomainSectionStatus({ liveCount: 3, detected: true, skipped: true })).toBe('done');
  });
});

describe('readDomainHint (from a loaded OnboardingStatus)', () => {
  it('reads a "detected · review" hint encoded as an in_progress section entry', () => {
    const s = statusWith({ debt: { status: 'in_progress', proposalId: 'dec_1' } });
    expect(readDomainHint(s, 'debt')).toEqual({ detected: true, proposalId: 'dec_1' });
    expect(deriveDomainBoardStatus(readDomainHint(s, 'debt'))).toBe('detected');
  });

  it('reads a done hint and explicit dispositions', () => {
    expect(readDomainHint(statusWith({ leases: { status: 'done' } }), 'leases')).toEqual({ liveCount: 1 });
    expect(readDomainHint(statusWith({ debt: { status: 'n_a' } }), 'debt')).toEqual({ markedNotApplicable: true });
    expect(readDomainHint(statusWith({ debt: { status: 'skipped' } }), 'debt')).toEqual({ skipped: true });
  });

  it('picks up a future live count on status.counts (forward-compatible, no edit needed)', () => {
    const s = statusWith({}, { fixedAssets: 5 });
    expect(readDomainHint(s, 'fixed_assets')).toEqual({ liveCount: 5 });
    expect(deriveDomainBoardStatus(readDomainHint(s, 'fixed_assets'))).toBe('done');
  });

  it('is total on a null status or an absent key', () => {
    expect(readDomainHint(null, 'debt')).toEqual({});
    expect(readDomainHint(statusWith({}), 'debt')).toEqual({});
  });
});

// A tiny chainable Supabase stub that captures the update payload.
function makeAdmin(initialState: unknown): { admin: SupabaseClient; getWritten: () => unknown } {
  let written: unknown;
  const builder = {
    select: () => builder,
    update: (payload: unknown) => { written = payload; return builder; },
    eq: () => builder,
    maybeSingle: async () => ({ data: { onboarding_state: initialState }, error: null }),
    then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
  };
  const admin = { schema: () => ({ from: () => builder }) } as unknown as SupabaseClient;
  return { admin, getWritten: () => written };
}

describe('setDomainDetectedHint (read-merge-write, preserves everything)', () => {
  it('writes a detected hint under the domain key without clobbering other state', async () => {
    const { admin, getWritten } = makeAdmin({
      currentStep: 'opening',
      complete: false,
      sections: { welcome: { status: 'done', updatedAt: 't0' } },
    });

    const res = await setDomainDetectedHint(admin, 'org_1', 'debt', { detected: true, proposalId: 'dec_9' });
    expect(res.persisted).toBe(true);

    const w = getWritten() as { onboarding_state: { currentStep: string; complete: boolean; sections: Record<string, { status: string; proposalId?: string }> } };
    const state = w.onboarding_state;
    // Untouched flags survive.
    expect(state.currentStep).toBe('opening');
    expect(state.complete).toBe(false);
    // The pre-existing section key survives.
    expect(state.sections.welcome.status).toBe('done');
    // The new detected hint is written as in_progress + proposalId.
    expect(state.sections.debt.status).toBe('in_progress');
    expect(state.sections.debt.proposalId).toBe('dec_9');
  });

  it('degrades safely (persisted:false) when the read errors', async () => {
    const badBuilder = {
      select: () => badBuilder,
      eq: () => badBuilder,
      maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
    };
    const admin = { schema: () => ({ from: () => badBuilder }) } as unknown as SupabaseClient;
    const res = await setDomainDetectedHint(admin, 'org_1', 'leases', { detected: true });
    expect(res.persisted).toBe(false);
  });
});
