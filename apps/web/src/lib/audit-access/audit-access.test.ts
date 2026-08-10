/**
 * PBC workflow + External Auditor role — PURE proofs (no DB, no request context).
 *
 * The security-critical claim proven here: the External Auditor role's EFFECTIVE
 * permission profile is VIEW-ONLY — it grants no write verb anywhere in the catalog — and
 * the PBC state machine / overdue rule behave deterministically.
 */

import { describe, it, expect } from 'vitest';
import {
  canTransition,
  nextStatuses,
  isOverdue,
  requiredTierForUpdate,
  tierForStatus,
  PBC_STATUSES,
} from './pbc';
import {
  buildExternalAuditorMatrix,
  externalAuditorOverrideCells,
  WRITE_ACTIONS,
  isExternalAuditorRole,
  EXTERNAL_AUDITOR_ROLE_KEY,
} from './external-auditor-role';

describe('PBC status transitions', () => {
  it('allows the forward path REQUESTED → IN_PROGRESS → PROVIDED → ACCEPTED', () => {
    expect(canTransition('REQUESTED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'PROVIDED')).toBe(true);
    expect(canTransition('PROVIDED', 'ACCEPTED')).toBe(true);
  });

  it('allows waiving from any open state and reopening from terminal states', () => {
    expect(canTransition('REQUESTED', 'WAIVED')).toBe(true);
    expect(canTransition('PROVIDED', 'WAIVED')).toBe(true);
    expect(canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(true); // reopen
    expect(canTransition('WAIVED', 'REQUESTED')).toBe(true); // reinstate
  });

  it('rejects illegal / no-op transitions', () => {
    expect(canTransition('REQUESTED', 'ACCEPTED')).toBe(false); // must be provided first
    expect(canTransition('ACCEPTED', 'PROVIDED')).toBe(false);
    expect(canTransition('WAIVED', 'ACCEPTED')).toBe(false);
    for (const s of PBC_STATUSES) expect(canTransition(s, s)).toBe(false); // no self-loop
  });

  it('nextStatuses never includes the current status', () => {
    for (const s of PBC_STATUSES) expect(nextStatuses(s)).not.toContain(s);
  });
});

describe('PBC overdue rule', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  it('flags a past-due request that the client has not yet fulfilled', () => {
    expect(isOverdue('2026-06-01', 'REQUESTED', now)).toBe(true);
    expect(isOverdue('2026-06-01', 'IN_PROGRESS', now)).toBe(true);
  });
  it('is not overdue once provided / accepted / waived', () => {
    expect(isOverdue('2026-06-01', 'PROVIDED', now)).toBe(false);
    expect(isOverdue('2026-06-01', 'ACCEPTED', now)).toBe(false);
    expect(isOverdue('2026-06-01', 'WAIVED', now)).toBe(false);
  });
  it('is not overdue when the due date is today or future, or absent', () => {
    expect(isOverdue('2026-06-15', 'REQUESTED', now)).toBe(false);
    expect(isOverdue('2026-07-01', 'REQUESTED', now)).toBe(false);
    expect(isOverdue(null, 'REQUESTED', now)).toBe(false);
  });
});

describe('PBC tier mapping (requester vs fulfiller)', () => {
  it('maps client-side transitions to the fulfiller tier (compliance.manage)', () => {
    expect(tierForStatus('IN_PROGRESS')).toBe('fulfiller');
    expect(tierForStatus('PROVIDED')).toBe('fulfiller');
  });
  it('maps auditor-side transitions to the requester tier (compliance.view)', () => {
    expect(tierForStatus('ACCEPTED')).toBe('requester');
    expect(tierForStatus('WAIVED')).toBe('requester');
    expect(tierForStatus('REQUESTED')).toBe('requester');
  });
  it('requires the STRONGER tier when an update touches a fulfiller field', () => {
    expect(requiredTierForUpdate({ metadataChange: true })).toBe('requester');
    expect(requiredTierForUpdate({ status: 'ACCEPTED' })).toBe('requester');
    expect(requiredTierForUpdate({ documentIdChange: true })).toBe('fulfiller');
    expect(requiredTierForUpdate({ assignedToChange: true })).toBe('fulfiller');
    // metadata (requester) + doc attach (fulfiller) ⇒ fulfiller wins
    expect(requiredTierForUpdate({ metadataChange: true, documentIdChange: true })).toBe('fulfiller');
    expect(requiredTierForUpdate({})).toBeNull();
  });
});

describe('External Auditor role is VIEW-ONLY', () => {
  const matrix = buildExternalAuditorMatrix();

  it('grants NO write action anywhere in the catalog', () => {
    const granted: string[] = [];
    for (const feat of matrix) {
      for (const cell of feat.cells) {
        if (cell.allowed && (WRITE_ACTIONS as readonly string[]).includes(cell.action)) {
          granted.push(`${feat.featureId}:${cell.action}`);
        }
      }
    }
    expect(granted).toEqual([]);
  });

  it('grants view on core financial surfaces the auditor examines', () => {
    const allowed = (featureId: string, action: string) =>
      matrix.find((f) => f.featureId === featureId)?.cells.find((c) => c.action === action)?.allowed === true;
    expect(allowed('reports', 'view')).toBe(true);
    expect(allowed('journal_entries', 'view')).toBe(true);
    expect(allowed('bank_feed', 'view')).toBe(true);
    expect(allowed('invoices', 'view')).toBe(true);
    expect(allowed('audit_trail', 'view')).toBe(true);
    // Compliance view is what lets the auditor use the PBC list; manage stays denied.
    expect(allowed('compliance', 'view')).toBe(true);
    expect(allowed('compliance', 'manage')).toBe(false);
    // Reports may be exported (a read); no other export/mutation leaks in.
    expect(allowed('reports', 'export')).toBe(true);
  });

  it('denies money-movement and settings surfaces entirely', () => {
    const anyAllowed = (featureId: string) =>
      matrix.find((f) => f.featureId === featureId)?.cells.some((c) => c.allowed) === true;
    for (const f of ['payments', 'payments_execute', 'check_run', 'payroll_release', 'checks', 'settings_acct', 'settings_system', 'user_permissions', 'import', 'team']) {
      expect(anyAllowed(f)).toBe(false);
    }
  });

  it('every provisioned override cell is a read grant (view/export, allowed=true)', () => {
    for (const c of externalAuditorOverrideCells()) {
      expect(c.allowed).toBe(true);
      expect(['view', 'export']).toContain(c.action);
    }
  });

  it('recognizes the role key case-insensitively', () => {
    expect(isExternalAuditorRole(EXTERNAL_AUDITOR_ROLE_KEY)).toBe(true);
    expect(isExternalAuditorRole('External_Auditor')).toBe(true);
    expect(isExternalAuditorRole('company_admin')).toBe(false);
    expect(isExternalAuditorRole(null)).toBe(false);
  });
});
