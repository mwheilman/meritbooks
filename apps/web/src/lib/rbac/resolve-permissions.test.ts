/**
 * Effective-permission resolver — PURE merge-logic proof (no DB, no request context).
 *
 * Covers the security-critical invariant: system default MERGED with org override, with
 * FAIL-CLOSED behavior on unknown base role and non-catalog cells. The DB wrappers
 * (resolveRoleKind/fetchOverrides/effectivePermission/effectiveMatrix) are thin and
 * fail-closed by construction; the merge core proven here is what decides access.
 */

import { describe, it, expect } from 'vitest';
import {
  systemDefaultCell,
  mergeCell,
  cellKey,
  buildEffectiveMatrix,
} from './resolve-permissions';
import { hasPermission } from './permissions';

describe('mergeCell — override wins only when explicitly set', () => {
  it('keeps the system default when there is no override', () => {
    expect(mergeCell(true, undefined)).toBe(true);
    expect(mergeCell(false, undefined)).toBe(false);
  });

  it('an explicit override wins in BOTH directions (grant and revoke)', () => {
    expect(mergeCell(false, true)).toBe(true); // org grants beyond default
    expect(mergeCell(true, false)).toBe(false); // org revokes a default grant
  });
});

describe('systemDefaultCell — mirrors hasPermission and fails closed', () => {
  it('matches the frozen spine for a real role + cell', () => {
    // company_admin has everything; business_user is external and lacks bank_feed.
    expect(systemDefaultCell('company_admin', 'bank_feed', 'approve')).toBe(
      hasPermission('company_admin', 'bank_feed', 'approve'),
    );
    expect(systemDefaultCell('company_admin', 'bank_feed', 'approve')).toBe(true);
    expect(systemDefaultCell('business_user', 'bank_feed', 'approve')).toBe(false);
  });

  it('fails closed on a null base role (a custom role that clones from nothing)', () => {
    expect(systemDefaultCell(null, 'reports', 'view')).toBe(false);
  });

  it('fails closed on a non-catalog feature or action', () => {
    expect(systemDefaultCell('company_admin', 'not_a_feature', 'view')).toBe(false);
    expect(systemDefaultCell('company_admin', 'reports', 'delete')).toBe(false); // reports has no delete
  });
});

describe('buildEffectiveMatrix — pure UI matrix', () => {
  it('labels each cell default-vs-override and merges correctly', () => {
    // Clone accounting_specialist, then override: grant bills.approve (default false)
    // and revoke reports.view (default true).
    const overrides: Record<string, boolean> = {
      [cellKey('bills', 'approve')]: true,
      [cellKey('reports', 'view')]: false,
    };
    const matrix = buildEffectiveMatrix('accounting_specialist', overrides);

    const bills = matrix.find((f) => f.featureId === 'bills')!;
    const billsApprove = bills.cells.find((c) => c.action === 'approve')!;
    expect(billsApprove.defaultAllowed).toBe(false);
    expect(billsApprove.allowed).toBe(true);
    expect(billsApprove.source).toBe('override');

    const reports = matrix.find((f) => f.featureId === 'reports')!;
    const reportsView = reports.cells.find((c) => c.action === 'view')!;
    expect(reportsView.defaultAllowed).toBe(true);
    expect(reportsView.allowed).toBe(false);
    expect(reportsView.source).toBe('override');

    // An untouched cell keeps the default and is sourced 'default'.
    const billsView = bills.cells.find((c) => c.action === 'view')!;
    expect(billsView.source).toBe('default');
    expect(billsView.allowed).toBe(hasPermission('accounting_specialist', 'bills', 'view'));
  });

  it('a null base role with no overrides is a fully-denied matrix (fail closed)', () => {
    const matrix = buildEffectiveMatrix(null, {});
    for (const feat of matrix) {
      for (const cell of feat.cells) {
        expect(cell.allowed).toBe(false);
        expect(cell.defaultAllowed).toBe(false);
      }
    }
  });

  it('a bogus override cell key never leaks into the matrix', () => {
    // An override for a non-existent (feature, action) is simply never read by
    // buildEffectiveMatrix — it only iterates the real catalog.
    const matrix = buildEffectiveMatrix('accounting_specialist', {
      [cellKey('not_a_feature', 'view')]: true,
    });
    expect(matrix.some((f) => f.featureId === 'not_a_feature')).toBe(false);
  });
});
