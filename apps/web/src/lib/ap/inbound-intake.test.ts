import { describe, it, expect } from 'vitest';
import { normalizeEmailAddress, slugFromInboundAddress } from './inbound-intake';

describe('normalizeEmailAddress', () => {
  it('trims and lowercases a bare address', () => {
    expect(normalizeEmailAddress('  AP-Acme@Inbound.MeritBooks.app ')).toBe('ap-acme@inbound.meritbooks.app');
  });

  it('extracts the address from a "Display Name <addr>" form', () => {
    expect(normalizeEmailAddress('Acme AP <ap-acme@inbound.meritbooks.app>')).toBe(
      'ap-acme@inbound.meritbooks.app',
    );
  });

  it('is safe on empty/garbage input', () => {
    expect(normalizeEmailAddress('')).toBe('');
    expect(normalizeEmailAddress('   ')).toBe('');
  });
});

describe('slugFromInboundAddress', () => {
  it('parses ap-<slug>@ localparts', () => {
    expect(slugFromInboundAddress('ap-revived-interiors@inbound.meritbooks.app')).toBe('revived-interiors');
  });

  it('parses ap+<slug>@ plus-addressing', () => {
    expect(slugFromInboundAddress('ap+merit-management-group-live@inbound.meritbooks.app')).toBe(
      'merit-management-group-live',
    );
  });

  it('is case-insensitive', () => {
    expect(slugFromInboundAddress('AP-Acme@Inbound.MeritBooks.app')).toBe('acme');
  });

  it('returns null when the localpart is not an ap- address', () => {
    expect(slugFromInboundAddress('billing@inbound.meritbooks.app')).toBeNull();
    expect(slugFromInboundAddress('notanemail')).toBeNull();
  });
});
