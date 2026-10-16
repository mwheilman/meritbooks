/**
 * Onboarding state — the pure normalizer + merge that keep the widened section map
 * degrade-safe: a malformed blob never throws or corrupts, and a single-field patch
 * never clobbers the rest of the state.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSections,
  mergeOnboardingState,
  normalizeCompanies,
  isCompanyLive,
  companyOpeningState,
  needsOnboarding,
  buildCompanyOnboarding,
  honestSections,
  isLegacyEstablished,
  NEW_COMPANY_WINDOW_DAYS,
  type OnboardingStateFlag,
  type CompanyProbe,
  type CompanyOnboarding,
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

// ─────────────────────────────────────────────────────────────────────────────
// W2 — per-company first run.
// ─────────────────────────────────────────────────────────────────────────────

const base = { openingPosted: false, startedFresh: false, hasActivity: false, legacyEstablished: false };

describe('isCompanyLive (per-company, never "any entry in the org")', () => {
  it('a brand-new company with nothing is not live', () => {
    expect(isCompanyLive(base)).toBe(false);
  });
  it('posted opening balances make it live', () => {
    expect(isCompanyLive({ ...base, openingPosted: true, hasActivity: true })).toBe(true);
  });
  it('an explicit start-fresh choice makes it live', () => {
    expect(isCompanyLive({ ...base, startedFresh: true })).toBe(true);
  });
  it('activity alone does NOT make a first-run company live (e.g. a bank txn posted mid-onboarding)', () => {
    expect(isCompanyLive({ ...base, hasActivity: true })).toBe(false);
  });
  it('an established org grandfathers companies with real posted books', () => {
    expect(isCompanyLive({ ...base, hasActivity: true, legacyEstablished: true })).toBe(true);
    expect(isCompanyLive({ ...base, legacyEstablished: true })).toBe(false);
  });
});

describe('companyOpeningState', () => {
  it('posted wins over a stale start-fresh choice', () => {
    expect(companyOpeningState({ openingPosted: true, startedFresh: true })).toBe('posted');
    expect(companyOpeningState({ openingPosted: false, startedFresh: true })).toBe('started_fresh');
    expect(companyOpeningState({ openingPosted: false, startedFresh: false })).toBe('not_started');
  });
});

describe('isLegacyEstablished', () => {
  it('is true for setup_complete, a complete flag, or real org activity', () => {
    expect(isLegacyEstablished(true, null)).toBe(true);
    expect(isLegacyEstablished(false, { complete: true })).toBe(true);
    expect(isLegacyEstablished(false, null, true)).toBe(true);
    expect(isLegacyEstablished(false, { complete: false }, false)).toBe(false);
  });
});

describe('needsOnboarding (the root router predicate)', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const recent = '2026-10-10T00:00:00Z';
  const old = '2025-01-01T00:00:00Z';

  it('no companies yet → onboarding', () => {
    expect(needsOnboarding([], false, now)).toBe(true);
    expect(needsOnboarding([], true, now)).toBe(true);
  });
  it('first-run org: any non-live company → onboarding', () => {
    expect(needsOnboarding([{ live: true, createdAt: old }, { live: false, createdAt: old }], false, now)).toBe(true);
  });
  it('everything live → dashboard', () => {
    expect(needsOnboarding([{ live: true, createdAt: recent }], false, now)).toBe(false);
  });
  it('established org: a dormant legacy entity never traps the admin', () => {
    expect(needsOnboarding([{ live: true, createdAt: old }, { live: false, createdAt: old }], true, now)).toBe(false);
  });
  it(`established org: a company added within ${NEW_COMPANY_WINDOW_DAYS} days still routes to onboarding`, () => {
    expect(needsOnboarding([{ live: true, createdAt: old }, { live: false, createdAt: recent }], true, now)).toBe(true);
  });
  it('established org: an unknown created date fails safe (no bounce)', () => {
    expect(needsOnboarding([{ live: false, createdAt: null }], true, now)).toBe(false);
  });
});

describe('normalizeCompanies (defensive)', () => {
  it('keeps valid fresh/none entries and drops junk', () => {
    const out = normalizeCompanies({
      a: { opening: 'fresh', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'user_1' },
      b: { opening: 'none' },
      c: { opening: 'posted' },
      d: 42,
    });
    expect(Object.keys(out ?? {})).toEqual(['a', 'b']);
    expect(out?.a.updatedBy).toBe('user_1');
    expect(typeof out?.b.updatedAt).toBe('string');
  });
  it('returns undefined for junk', () => {
    expect(normalizeCompanies(null)).toBeUndefined();
    expect(normalizeCompanies([])).toBeUndefined();
    expect(normalizeCompanies({})).toBeUndefined();
  });
});

describe('mergeOnboardingState — per-company choices', () => {
  const now = '2026-10-16T00:00:00Z';
  it('merges a company choice by id without touching others, sections, or the step', () => {
    const prev: OnboardingStateFlag = {
      currentStep: 'opening',
      sections: { bank: { status: 'skipped', updatedAt: now } },
      companies: { a: { opening: 'fresh', updatedAt: now } },
    };
    const merged = mergeOnboardingState(prev, { companies: { b: { opening: 'fresh', updatedAt: now } } }, now);
    expect(merged.companies?.a.opening).toBe('fresh');
    expect(merged.companies?.b.opening).toBe('fresh');
    expect(merged.sections?.bank?.status).toBe('skipped');
    expect(merged.currentStep).toBe('opening');
  });
  it('a later "none" undoes a fresh choice for that company', () => {
    const prev: OnboardingStateFlag = { companies: { a: { opening: 'fresh', updatedAt: now } } };
    const merged = mergeOnboardingState(prev, { companies: { a: { opening: 'none', updatedAt: now } } }, now);
    expect(merged.companies?.a.opening).toBe('none');
  });
});

describe('buildCompanyOnboarding', () => {
  const probe = (over: Partial<CompanyProbe>): CompanyProbe => ({
    id: 'x', name: 'X', shortCode: 'X', createdAt: null, hasActivity: false, openingPosted: false, ...over,
  });
  it('combines ledger truth with the persisted fresh choice', () => {
    const out = buildCompanyOnboarding(
      [probe({ id: 'a' }), probe({ id: 'b', hasActivity: true, openingPosted: true }), probe({ id: 'c' })],
      { a: { opening: 'fresh', updatedAt: '' }, c: { opening: 'none', updatedAt: '' } },
      false,
    );
    expect(out.map((c) => [c.id, c.opening, c.live])).toEqual([
      ['a', 'started_fresh', true],
      ['b', 'posted', true],
      ['c', 'not_started', false],
    ]);
  });
});

describe('honestSections — a stale org-level "skipped" never satisfies go-live', () => {
  const company = (over: Partial<CompanyOnboarding>): CompanyOnboarding => ({
    id: 'a', name: 'A', shortCode: 'A', createdAt: null, opening: 'not_started', hasActivity: false, live: false, ...over,
  });
  const at = '2026-10-01T00:00:00Z';

  it('drops a source-picker "skipped" when no company actually chose start-fresh', () => {
    const out = honestSections({ opening: { status: 'skipped', updatedAt: at } }, [company({})]);
    expect(out.opening).toBeUndefined();
  });
  it('keeps progress as in_progress when some company moved but not all are live', () => {
    const out = honestSections(
      { opening: { status: 'skipped', updatedAt: at } },
      [company({ id: 'a', opening: 'started_fresh', live: true }), company({ id: 'b' })],
    );
    expect(out.opening?.status).toBe('in_progress');
  });
  it('reports skipped when every company is live and one started fresh', () => {
    const out = honestSections({}, [company({ opening: 'started_fresh', live: true })]);
    expect(out.opening?.status).toBe('skipped');
  });
  it('leaves other sections and the no-company case untouched', () => {
    const stored = { bank: { status: 'skipped' as const, updatedAt: at } };
    expect(honestSections(stored, [])).toEqual(stored);
    expect(honestSections(stored, [company({})]).bank?.status).toBe('skipped');
  });
});
