import { describe, it, expect } from 'vitest';
import {
  portalTokenStatus,
  isPortalTokenUsable,
  generatePortalToken,
} from './tokens';

/**
 * Pure token status/usability logic — the security-critical decision that gates
 * the public portal. No DB required. Covers active vs revoked vs expired
 * (by-status AND by-date), and the shape/entropy of a minted token.
 */
describe('portalTokenStatus', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('an ACTIVE token with no expiry is ACTIVE and usable', () => {
    const row = { status: 'ACTIVE', expires_at: null };
    expect(portalTokenStatus(row, now)).toBe('ACTIVE');
    expect(isPortalTokenUsable(row, now)).toBe(true);
  });

  it('a REVOKED token is never usable, even if not past its expiry', () => {
    const row = { status: 'REVOKED', expires_at: '2099-01-01T00:00:00Z' };
    expect(portalTokenStatus(row, now)).toBe('REVOKED');
    expect(isPortalTokenUsable(row, now)).toBe(false);
  });

  it('an ACTIVE-stored token past its expires_at is EXPIRED (lazy expiry, fails closed)', () => {
    const row = { status: 'ACTIVE', expires_at: '2026-08-01T00:00:00Z' };
    expect(portalTokenStatus(row, now)).toBe('EXPIRED');
    expect(isPortalTokenUsable(row, now)).toBe(false);
  });

  it('an ACTIVE token whose expiry is still in the future stays ACTIVE', () => {
    const row = { status: 'ACTIVE', expires_at: '2026-09-01T00:00:00Z' };
    expect(portalTokenStatus(row, now)).toBe('ACTIVE');
    expect(isPortalTokenUsable(row, now)).toBe(true);
  });

  it('an EXPIRED-stored token reports EXPIRED regardless of date', () => {
    const row = { status: 'EXPIRED', expires_at: null };
    expect(portalTokenStatus(row, now)).toBe('EXPIRED');
    expect(isPortalTokenUsable(row, now)).toBe(false);
  });
});

describe('generatePortalToken', () => {
  it('mints a 64-char lowercase-hex, unguessable, unique token', () => {
    const a = generatePortalToken();
    const b = generatePortalToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
