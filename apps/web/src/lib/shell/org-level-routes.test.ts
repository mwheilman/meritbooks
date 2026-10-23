import { describe, expect, it } from 'vitest';
import { ORG_LEVEL_PREFIXES, isOrgLevelRoute } from './org-level-routes';

describe('isOrgLevelRoute', () => {
  it('matches org-wide pages and everything under them', () => {
    for (const p of ['/settings', '/settings/approvals', '/settings/access/log', '/team', '/platform', '/onboarding/portfolio', '/integrations/erp', '/inbox', '/dashboard', '/portfolio/abc', '/consolidation', '/no-access', '/search']) {
      expect(isOrgLevelRoute(p), p).toBe(true);
    }
  });

  it('does not match client-scoped processing pages', () => {
    for (const p of ['/bills', '/bank-feed', '/invoices/123', '/payroll', '/journal-entries', '/dealer/units', '/reports', '/close']) {
      expect(isOrgLevelRoute(p), p).toBe(false);
    }
  });

  it('only matches whole path segments, and ignores query, hash and trailing slash', () => {
    expect(isOrgLevelRoute('/settings-archive')).toBe(false);
    expect(isOrgLevelRoute('/teams')).toBe(false);
    expect(isOrgLevelRoute('/settings/')).toBe(true);
    expect(isOrgLevelRoute('/inbox?tab=exceptions')).toBe(true);
    expect(isOrgLevelRoute('/team#members')).toBe(true);
  });

  it('treats a missing path as client-level (indicator stays on)', () => {
    expect(isOrgLevelRoute(null)).toBe(false);
    expect(isOrgLevelRoute(undefined)).toBe(false);
    expect(isOrgLevelRoute('')).toBe(false);
    expect(isOrgLevelRoute('/')).toBe(false);
  });

  it('every prefix is an absolute path without a trailing slash', () => {
    for (const p of ORG_LEVEL_PREFIXES) expect(p).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/);
  });
});
