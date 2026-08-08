/**
 * Tenant-reset registry — safety invariants for the pure plan module.
 *
 * These guard the two properties that matter most for a destructive feature:
 *   1. The PRESERVED shell (org, users, memberships) is never in any delete scope.
 *   2. Optional scopes are OFF by default, so a naive/default reset only clears
 *      transactional data — never master data or the chart of accounts.
 */

import { describe, it, expect } from 'vitest';
import {
  RESET_TABLES,
  DEFAULT_RESET_OPTIONS,
  tablesForOptions,
  scopesForOptions,
  tableKey,
} from './reset-plan';

describe('tenant reset plan', () => {
  it('never targets the preserved identity/org shell', () => {
    const forbidden = new Set([
      'core.organizations',
      'core.users',
      'core.memberships',
      'core.membership_locations',
      'core.platform_admin_sessions',
    ]);
    for (const t of RESET_TABLES) {
      expect(forbidden.has(tableKey(t))).toBe(false);
    }
  });

  it('defaults preserve master data and the chart of accounts', () => {
    expect(DEFAULT_RESET_OPTIONS.clearMasterData).toBe(false);
    expect(DEFAULT_RESET_OPTIONS.clearChartOfAccounts).toBe(false);

    const scopes = scopesForOptions(DEFAULT_RESET_OPTIONS);
    expect(scopes).toEqual(['transactional']);

    const tables = tablesForOptions(DEFAULT_RESET_OPTIONS);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((t) => t.scope === 'transactional')).toBe(true);
  });

  it('opting in widens the scope monotonically', () => {
    const base = tablesForOptions(DEFAULT_RESET_OPTIONS).length;
    const withMaster = tablesForOptions({ clearMasterData: true, clearChartOfAccounts: false }).length;
    const withBoth = tablesForOptions({ clearMasterData: true, clearChartOfAccounts: true }).length;
    expect(withMaster).toBeGreaterThan(base);
    expect(withBoth).toBeGreaterThan(withMaster);
  });

  it('has unique, well-formed table keys in known schemas', () => {
    const keys = RESET_TABLES.map(tableKey);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    for (const t of RESET_TABLES) {
      expect(['public', 'core']).toContain(t.schema);
      expect(t.table).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('excludes the separate PM module (proj.*) from reset scope', () => {
    expect(RESET_TABLES.some((t) => (t.schema as string) === 'proj')).toBe(false);
  });
});
