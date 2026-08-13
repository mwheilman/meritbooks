/**
 * Onboarding state — the pure normalizer + merge that keep the widened section map
 * degrade-safe: a malformed blob never throws or corrupts, and a single-field patch
 * never clobbers the rest of the state.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSections,
  mergeOnboardingState,
  type OnboardingStateFlag,
} from './status';

describe('normalizeSections (defensive round-trip)', () => {
  it('keeps valid entries and preserves updatedBy/proposalId', () => {
    const raw = {
      opening: { status: 'done', updatedAt: '2026-08-01T00:00:00Z', updatedBy: 'user_1', proposalId: 'dec_9' },
      bank: { status: 'skipped', updatedAt: '2026-08-02T00:00:00Z' },
    };
    const out = normalizeSections(raw);
    expect(out).toEqual({
      opening: { status: 'done', updatedAt: '2026-08-01T00:00:00Z', updatedBy: 'user_1', proposalId: 'dec_9' },
      bank: { status: 'skipped', updatedAt: '2026-08-02T00:00:00Z' },
    });
  });

  it('drops unknown section keys and unknown status values', () => {
    const raw = {
      opening: { status: 'done', updatedAt: '2026-08-01T00:00:00Z' },
      not_a_section: { status: 'done', updatedAt: '2026-08-01T00:00:00Z' },
      coa: { status: 'bogus', updatedAt: '2026-08-01T00:00:00Z' },
    };
    const out = normalizeSections(raw);
    expect(Object.keys(out ?? {})).toEqual(['opening']);
  });

  it('supplies a default updatedAt when missing rather than throwing', () => {
    const out = normalizeSections({ team: { status: 'in_progress' } });
    expect(out?.team?.status).toBe('in_progress');
    expect(typeof out?.team?.updatedAt).toBe('string');
  });

  it('returns undefined for junk / empty input', () => {
    expect(normalizeSections(null)).toBeUndefined();
    expect(normalizeSections('nope')).toBeUndefined();
    expect(normalizeSections({})).toBeUndefined();
    expect(normalizeSections({ opening: 42 })).toBeUndefined();
  });
});

describe('mergeOnboardingState (single-field patch never clobbers the rest)', () => {
  const now = '2026-08-12T00:00:00Z';

  it('writing a section status preserves currentStep + other sections', () => {
    const prev: OnboardingStateFlag = {
      currentStep: 'opening',
      complete: false,
      sections: { welcome: { status: 'done', updatedAt: '2026-08-01T00:00:00Z' } },
    };
    const merged = mergeOnboardingState(
      prev,
      { sections: { opening: { status: 'done', updatedAt: now } } },
      now,
    );
    expect(merged.currentStep).toBe('opening'); // step untouched
    expect(merged.sections?.welcome?.status).toBe('done'); // other section retained
    expect(merged.sections?.opening?.status).toBe('done'); // new section merged in
    expect(merged.updatedAt).toBe(now);
  });

  it('writing currentStep preserves the section map', () => {
    const prev: OnboardingStateFlag = {
      currentStep: 'welcome',
      sections: { opening: { status: 'in_progress', updatedAt: '2026-08-01T00:00:00Z' } },
    };
    const merged = mergeOnboardingState(prev, { currentStep: 'bank' }, now);
    expect(merged.currentStep).toBe('bank');
    expect(merged.sections?.opening?.status).toBe('in_progress');
  });

  it('a same-key section patch overwrites just that entry', () => {
    const prev: OnboardingStateFlag = {
      sections: { opening: { status: 'in_progress', updatedAt: '2026-08-01T00:00:00Z' } },
    };
    const merged = mergeOnboardingState(prev, { sections: { opening: { status: 'done', updatedAt: now } } }, now);
    expect(merged.sections?.opening).toEqual({ status: 'done', updatedAt: now });
  });

  it('merges onto a null/absent prior state without throwing', () => {
    const merged = mergeOnboardingState(null, { complete: true }, now);
    expect(merged.complete).toBe(true);
    expect(merged.updatedAt).toBe(now);
    expect(merged.sections).toBeUndefined();
  });
});
