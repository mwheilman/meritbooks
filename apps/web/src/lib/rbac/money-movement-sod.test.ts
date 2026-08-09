/**
 * Money-movement Segregation-of-Duties (SoD) — per-route permission proof (task #56).
 *
 * The money routes were split from one coarse `payments` key into four granular
 * per-route keys (payments_execute / check_run / ap_disbursement_release /
 * payroll_release) behind requireMoneyMovement()'s monotonic resolver. The keys are
 * NOT YET in the RESERVED catalog (lib/rbac/permissions.ts) — this suite is written
 * degrade-safe so it is meaningful in BOTH states:
 *
 *   - BEFORE the catalog diff lands: every granular key is uncatalogued, so
 *     hasPermission() fails CLOSED for every role. The suite asserts that (proving the
 *     split is safe to ship ahead of the catalog change) AND pins the CURRENT
 *     effective access via the coarse `payments` key, which IS catalogued today.
 *   - AFTER the lead applies the proposed diff: each granular key is catalogued with a
 *     grant map IDENTICAL to today's coarse `payments` grants, so the suite asserts the
 *     exact per-role execute matrix and the SoD/monotonic invariants against real code.
 *
 * The decision layer under test is the pure hasPermission()/permissionDenied() — no
 * DB, no request context — the same primitives the route guards call.
 *
 * INVARIANT (why this suite exists): a granular key may NEVER be LOOSER than today's
 * coarse `payments` gate. Adding the keys must not grant money movement to any role
 * that cannot move money today, nor lock out any role that can.
 */

import { describe, it, expect } from 'vitest';
import { hasPermission, ALL_ROLES, type UserRole } from './permissions';
import { permissionDenied } from './require-permission';
import {
  PAYMENTS_FEATURE,
  PAYMENTS_EXECUTE, // 'run' — the catalog's execute verb
  featureInCatalog,
  PAYMENTS_EXECUTE_FEATURE,
  CHECK_RUN_FEATURE,
  AP_DISBURSEMENT_RELEASE_FEATURE,
  PAYROLL_RELEASE_FEATURE,
} from './payments-permission';

/**
 * The four granular per-route money-movement keys, paired with the route that gates
 * on each. (Verified in-tree: each route passes exactly this key to
 * requireMoneyMovement.)
 */
const GRANULAR_KEYS = [
  PAYMENTS_EXECUTE_FEATURE, // POST /api/payments               — record customer payment
  CHECK_RUN_FEATURE, // POST /api/checks/run                    — queue AP disbursement approvals
  AP_DISBURSEMENT_RELEASE_FEATURE, // POST /api/ap/disbursements/release — release approved AP batch
  PAYROLL_RELEASE_FEATURE, // POST /api/payroll/runs/[id]/release — release payroll to provider
] as const;

/**
 * The CURRENT effective execute-access for money movement, derived from the coarse
 * `payments:run` grants shipped in ROLE_DEFINITIONS today. Because `payments` is the
 * only money-movement key currently in the catalog, ALL FOUR routes resolve on it
 * today, so this map IS today's effective access for every money route.
 *
 * The proposed diff sets each granular key to EXACTLY this map — nothing loosened,
 * nothing newly locked out.
 */
const EXECUTE_GRANT: Record<UserRole, boolean> = {
  company_admin: true,
  cfo: true,
  merit_controller: true,
  assistant_cfo: true,
  accounting_manager: true,
  accounting_specialist: false,
  check_processor: false, // NOTE: cannot run /api/checks/run TODAY (coarse `payments` denies it).
  general_admin: false,
  business_user: false,
};

describe('current effective money-movement access (coarse `payments` key, live today)', () => {
  it('pins exactly who can execute money movement today, per role', () => {
    // Runs against the REAL catalog NOW: `payments` is catalogued (permissions.ts).
    expect(featureInCatalog(PAYMENTS_FEATURE)).toBe(true);
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).toBe(EXECUTE_GRANT[role]);
    }
  });

  it('the privileged set is exactly the five full/assigned finance roles', () => {
    const allowed = ALL_ROLES.filter((r) => hasPermission(r, PAYMENTS_FEATURE, PAYMENTS_EXECUTE));
    expect([...allowed].sort()).toEqual(
      ['accounting_manager', 'assistant_cfo', 'cfo', 'company_admin', 'merit_controller'].sort(),
    );
  });
});

describe('granular per-route keys — distinct and (proposed) grant-equal to coarse `payments`', () => {
  it('exposes four distinct keys (real SoD: a role can hold one without the others)', () => {
    expect(new Set(GRANULAR_KEYS).size).toBe(4);
    expect([...GRANULAR_KEYS]).toEqual([
      'payments_execute',
      'check_run',
      'ap_disbursement_release',
      'payroll_release',
    ]);
  });

  it('resolves correctly per role in BOTH catalog states (degrade-safe)', () => {
    for (const key of GRANULAR_KEYS) {
      if (!featureInCatalog(key)) {
        // Pre-diff: uncatalogued → hasPermission fails CLOSED for EVERY role. This is
        // why requireMoneyMovement() degrades to the coarse `payments` superset rather
        // than gating on an uncatalogued key; the split is safe to ship first.
        for (const role of ALL_ROLES) {
          expect(hasPermission(role, key, PAYMENTS_EXECUTE)).toBe(false);
          expect(permissionDenied(role, key, PAYMENTS_EXECUTE)).not.toBeNull();
        }
      } else {
        // Post-diff: catalogued with the proposed map → identical to today's effective
        // access. Nothing loosened, nothing newly denied.
        for (const role of ALL_ROLES) {
          expect(hasPermission(role, key, PAYMENTS_EXECUTE)).toBe(EXECUTE_GRANT[role]);
          expect(permissionDenied(role, key, PAYMENTS_EXECUTE) === null).toBe(EXECUTE_GRANT[role]);
        }
      }
    }
  });
});

describe('MONOTONIC invariant — no granular key is ever LOOSER than today', () => {
  it('granular execute-grant is a subset-or-equal of the coarse `payments` grant, for every role', () => {
    // Holds in both states: pre-diff LHS is false (implication vacuous); post-diff
    // LHS === RHS. A granular grant can never exceed the coarse superset it fell back
    // to, so the split cannot loosen production money movement.
    for (const key of GRANULAR_KEYS) {
      for (const role of ALL_ROLES) {
        const granular = hasPermission(role, key, PAYMENTS_EXECUTE);
        const coarse = hasPermission(role, PAYMENTS_FEATURE, PAYMENTS_EXECUTE);
        if (granular) expect(coarse).toBe(true); // granular ⊆ coarse
      }
    }
  });

  it('no role gains money movement it lacked under the coarse key', () => {
    for (const key of GRANULAR_KEYS) {
      for (const role of ALL_ROLES) {
        if (!hasPermission(role, PAYMENTS_FEATURE, PAYMENTS_EXECUTE)) {
          // Denied by the coarse key today ⇒ must stay denied by every granular key.
          expect(hasPermission(role, key, PAYMENTS_EXECUTE)).toBe(false);
        }
      }
    }
  });
});

describe('SoD — sensitive money-out authority stays constrained', () => {
  it('unprivileged/external roles are DENIED every money-movement route', () => {
    for (const role of ['business_user', 'general_admin', 'accounting_specialist'] as const) {
      for (const key of GRANULAR_KEYS) {
        expect(permissionDenied(role, key, PAYMENTS_EXECUTE)).not.toBeNull();
      }
    }
  });

  it('check_processor cannot RELEASE payroll (payroll_release withheld)', () => {
    // Under strict preservation check_processor holds NO money-movement key today, so
    // it certainly cannot release payroll. This assertion is the load-bearing SoD guard:
    // even if a future Owner decision grants check_processor `check_run`, this must stay
    // red — a check-runner must never be able to release payroll.
    expect(hasPermission('check_processor', PAYROLL_RELEASE_FEATURE, PAYMENTS_EXECUTE)).toBe(false);
    expect(permissionDenied('check_processor', PAYROLL_RELEASE_FEATURE, PAYMENTS_EXECUTE)).not.toBeNull();
  });

  it('check_processor is DENIED ap_disbursement_release (releaser authority withheld)', () => {
    expect(permissionDenied('check_processor', AP_DISBURSEMENT_RELEASE_FEATURE, PAYMENTS_EXECUTE)).not.toBeNull();
  });

  it('every privileged finance role CAN execute payroll_release once the diff lands', () => {
    for (const role of ['company_admin', 'cfo', 'merit_controller', 'assistant_cfo', 'accounting_manager'] as const) {
      if (featureInCatalog(PAYROLL_RELEASE_FEATURE)) {
        expect(permissionDenied(role, PAYROLL_RELEASE_FEATURE, PAYMENTS_EXECUTE)).toBeNull();
      } else {
        // Pre-diff the granular key is uncatalogued; authority currently flows through
        // the coarse `payments` key, which these roles all hold.
        expect(hasPermission(role, PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).toBe(true);
      }
    }
  });
});
