/**
 * Unit tests for company (entity) scoping — the pure control that pins processing
 * work to one company, reads the active-company cookie, and gates consolidation.
 *
 * Pure module (no next/headers, no I/O) so these tests need no DB / network / AI.
 */

import { describe, it, expect } from 'vitest';
import {
  ACTIVE_COMPANY_COOKIE,
  ALL_COMPANIES,
  readActiveCompanyCookie,
  isSpecificCompany,
  canConsolidate,
} from './company-scope';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('ALL_COMPANIES sentinel', () => {
  it("is the string 'all'", () => {
    expect(ALL_COMPANIES).toBe('all');
  });
  it('cookie name is stable', () => {
    expect(ACTIVE_COMPANY_COOKIE).toBe('mb_active_company');
  });
});

describe('isSpecificCompany', () => {
  it('true for a real company id (uuid)', () => {
    expect(isSpecificCompany(UUID)).toBe(true);
  });
  it('false for the ALL_COMPANIES sentinel', () => {
    expect(isSpecificCompany(ALL_COMPANIES)).toBe(false);
    expect(isSpecificCompany('all')).toBe(false);
  });
  it('false for null / undefined / empty string', () => {
    expect(isSpecificCompany(null)).toBe(false);
    expect(isSpecificCompany(undefined)).toBe(false);
    expect(isSpecificCompany('')).toBe(false);
  });
  it('treats any other non-empty string as specific', () => {
    // Only the exact 'all' sentinel is consolidated; other labels are specific ids.
    expect(isSpecificCompany('loc_123')).toBe(true);
    expect(isSpecificCompany('ALL')).toBe(true); // case-sensitive sentinel
  });
});

describe('readActiveCompanyCookie', () => {
  it('returns ALL_COMPANIES when the cookie string is absent', () => {
    expect(readActiveCompanyCookie(null)).toBe(ALL_COMPANIES);
    expect(readActiveCompanyCookie(undefined)).toBe(ALL_COMPANIES);
    expect(readActiveCompanyCookie('')).toBe(ALL_COMPANIES);
  });

  it('returns ALL_COMPANIES when the cookie is not present in the string', () => {
    expect(readActiveCompanyCookie('other=1; theme=dark')).toBe(ALL_COMPANIES);
  });

  it('reads the value when the cookie is the only pair', () => {
    expect(readActiveCompanyCookie(`${ACTIVE_COMPANY_COOKIE}=${UUID}`)).toBe(UUID);
  });

  it('reads the value when surrounded by other cookies', () => {
    const raw = `theme=dark; ${ACTIVE_COMPANY_COOKIE}=${UUID}; sid=abc`;
    expect(readActiveCompanyCookie(raw)).toBe(UUID);
  });

  it('tolerates missing space after the semicolon', () => {
    expect(readActiveCompanyCookie(`a=1;${ACTIVE_COMPANY_COOKIE}=${UUID};b=2`)).toBe(UUID);
  });

  it('URL-decodes the value', () => {
    // A value that was percent-encoded on write must round-trip on read.
    const raw = `${ACTIVE_COMPANY_COOKIE}=${encodeURIComponent('a b&c')}`;
    expect(readActiveCompanyCookie(raw)).toBe('a b&c');
  });

  it('returns ALL_COMPANIES when the cookie is present but empty', () => {
    expect(readActiveCompanyCookie(`${ACTIVE_COMPANY_COOKIE}=`)).toBe(ALL_COMPANIES);
  });

  it('does not match a cookie whose name is a suffix of the target', () => {
    // A cookie literally named 'x_mb_active_company' must not be mistaken for ours.
    expect(readActiveCompanyCookie(`x_${ACTIVE_COMPANY_COOKIE}=${UUID}`)).toBe(ALL_COMPANIES);
  });
});

describe('canConsolidate', () => {
  it('false for anonymous / null / undefined user (fail closed)', () => {
    expect(canConsolidate(null)).toBe(false);
    expect(canConsolidate(undefined)).toBe(false);
  });

  it('true for a company_admin regardless of canManageUsers', () => {
    expect(canConsolidate({ role: 'company_admin', canManageUsers: false })).toBe(true);
  });

  it('true for any user who canManageUsers (leadership)', () => {
    expect(canConsolidate({ role: 'accounting_specialist', canManageUsers: true })).toBe(true);
  });

  it('false for a non-admin who cannot manage users', () => {
    expect(canConsolidate({ role: 'accounting_specialist', canManageUsers: false })).toBe(false);
    expect(canConsolidate({ role: 'business_user', canManageUsers: false })).toBe(false);
  });

  it('requires canManageUsers to be strictly true (no truthy coercion)', () => {
    // Guards against a loose `if (user.canManageUsers)` — the impl uses === true.
    expect(canConsolidate({ role: 'business_user', canManageUsers: undefined as unknown as boolean })).toBe(false);
  });
});
