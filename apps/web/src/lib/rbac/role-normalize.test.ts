/**
 * Unit tests for normalizeMembershipRole — the fail-closed bridge from the free-form
 * Core membership vocabulary onto the Books UserRole catalog. Money-movement approval
 * rides on this mapping, so every edge (prefix, case, unknown) is asserted.
 */

import { describe, it, expect } from 'vitest';
import { normalizeMembershipRole } from './role-normalize';
import { ALL_ROLES } from './permissions';

describe('full-admin membership roles → company_admin', () => {
  it.each(['owner', 'admin', 'org_admin', 'company_admin'])(
    "maps '%s' to company_admin",
    (raw) => {
      expect(normalizeMembershipRole(raw)).toBe('company_admin');
    },
  );

  it('accepts the org: prefix (Clerk emits org:owner / org:admin)', () => {
    expect(normalizeMembershipRole('org:owner')).toBe('company_admin');
    expect(normalizeMembershipRole('org:admin')).toBe('company_admin');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeMembershipRole('OWNER')).toBe('company_admin');
    expect(normalizeMembershipRole('  Org:Admin  ')).toBe('company_admin');
    expect(normalizeMembershipRole('Org_Admin')).toBe('company_admin');
  });
});

describe('the 9 canonical UserRoles pass through unchanged', () => {
  it.each(ALL_ROLES)("passes '%s' through", (role) => {
    expect(normalizeMembershipRole(role)).toBe(role);
  });

  it('passes a canonical role through even with org: prefix and mixed case', () => {
    expect(normalizeMembershipRole('org:Check_Processor')).toBe('check_processor');
    expect(normalizeMembershipRole('ACCOUNTING_SPECIALIST')).toBe('accounting_specialist');
  });
});

describe('fail closed on no-authority vocabulary', () => {
  it("Clerk's bare 'member' has no authority → null", () => {
    expect(normalizeMembershipRole('member')).toBeNull();
    expect(normalizeMembershipRole('org:member')).toBeNull();
  });

  it('unknown role → null', () => {
    expect(normalizeMembershipRole('superuser')).toBeNull();
    expect(normalizeMembershipRole('guest')).toBeNull();
  });

  it('empty / whitespace-only / prefix-only → null', () => {
    expect(normalizeMembershipRole('')).toBeNull();
    expect(normalizeMembershipRole('   ')).toBeNull();
    expect(normalizeMembershipRole('org:')).toBeNull();
  });

  it('null / undefined / non-string → null', () => {
    expect(normalizeMembershipRole(null)).toBeNull();
    expect(normalizeMembershipRole(undefined)).toBeNull();
    // Defensive: the impl guards typeof !== 'string'.
    expect(normalizeMembershipRole(123 as unknown as string)).toBeNull();
    expect(normalizeMembershipRole({} as unknown as string)).toBeNull();
  });
});
