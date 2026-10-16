import { describe, it, expect } from 'vitest';
import { decideFrontDoor, decideOnboardingFlow, isSetupOwner, type FrontDoorInput } from './front-door';

const OWNER: FrontDoorInput = {
  canRunSetup: true, isInvitee: false, ownsOnboarding: false, needsOnboarding: true, hasSeenTour: false,
};

describe('isSetupOwner', () => {
  it('the org creator who can run setup is the owner', () => {
    expect(isSetupOwner(OWNER)).toBe(true);
  });
  it('an invited bookkeeper named onboarding owner IS the owner', () => {
    expect(isSetupOwner({ canRunSetup: true, isInvitee: true, ownsOnboarding: true })).toBe(true);
  });
  it('an invitee with setup rights but no onboarding assignment is NOT the owner', () => {
    expect(isSetupOwner({ canRunSetup: true, isInvitee: true, ownsOnboarding: false })).toBe(false);
  });
  it('someone who cannot run setup is never the owner', () => {
    expect(isSetupOwner({ canRunSetup: false, isInvitee: false, ownsOnboarding: true })).toBe(false);
  });
});

describe('decideFrontDoor (the / router + dashboard first-run redirect)', () => {
  it('owner with a company not yet live → onboarding', () => {
    expect(decideFrontDoor(OWNER)).toBe('/onboarding');
  });
  it('owner of an established / live org → dashboard (never trapped)', () => {
    expect(decideFrontDoor({ ...OWNER, needsOnboarding: false })).toBe('/dashboard');
  });
  it('invitee joining a LIVE company, first login → tour', () => {
    expect(decideFrontDoor({ ...OWNER, isInvitee: true, needsOnboarding: false })).toBe('/onboarding/tour');
  });
  it('invitee joining a company someone else is still setting up → tour, not setup', () => {
    expect(decideFrontDoor({ ...OWNER, isInvitee: true, needsOnboarding: true })).toBe('/onboarding/tour');
  });
  it('a member who cannot run setup, tour already seen → dashboard', () => {
    expect(decideFrontDoor({ ...OWNER, canRunSetup: false, hasSeenTour: true })).toBe('/dashboard');
  });
  it('an invited onboarding owner still goes to onboarding', () => {
    expect(decideFrontDoor({ ...OWNER, isInvitee: true, ownsOnboarding: true })).toBe('/onboarding');
  });
});

describe('decideOnboardingFlow (the /onboarding company-state router)', () => {
  it('can run setup: setup while not live, wizard (live) once live', () => {
    expect(decideOnboardingFlow({ companyLive: false, canRunSetup: true, hasSeenTour: false })).toBe('setup');
    expect(decideOnboardingFlow({ companyLive: true, canRunSetup: true, hasSeenTour: false })).toBe('live');
  });
  it('cannot run setup + company NOT live → tour (never setup-then-bounce)', () => {
    expect(decideOnboardingFlow({ companyLive: false, canRunSetup: false, hasSeenTour: false })).toBe('tour');
  });
  it('cannot run setup + tour seen → dashboard', () => {
    expect(decideOnboardingFlow({ companyLive: false, canRunSetup: false, hasSeenTour: true })).toBe('dashboard');
    expect(decideOnboardingFlow({ companyLive: true, canRunSetup: false, hasSeenTour: true })).toBe('dashboard');
  });
  it('?tour=1 on a live company always shows the tour', () => {
    expect(decideOnboardingFlow({ companyLive: true, canRunSetup: true, hasSeenTour: true, tourForced: true })).toBe('tour');
  });
  it('?tour=1 does not hijack an owner mid-setup', () => {
    expect(decideOnboardingFlow({ companyLive: false, canRunSetup: true, hasSeenTour: true, tourForced: true })).toBe('setup');
  });
});
