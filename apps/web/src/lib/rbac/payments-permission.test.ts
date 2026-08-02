/**
 * Dedicated money-movement (payments) permission — authorization proof.
 *
 * Proves an UNPRIVILEGED member is denied a money-movement route, and that gating
 * on the not-yet-catalogued `payments` key fails CLOSED (which is exactly why
 * requireMoneyMovement() keeps the legacy fallback until the reserved catalog
 * adopts `payments`). The decision layer under test is the pure permissionDenied()
 * — no DB, no request context — the same function the route guard calls.
 */

import { describe, it, expect } from 'vitest';
import { permissionDenied } from './require-permission';
import {
  PAYMENTS_FEATURE,
  PAYMENTS_VIEW,
  PAYMENTS_EXECUTE,
  paymentsFeatureInCatalog,
} from './payments-permission';

describe('payments permission — constants', () => {
  it('binds execute to a real FeatureAction verb so requirePermission typechecks', () => {
    expect(PAYMENTS_FEATURE).toBe('payments');
    expect(PAYMENTS_VIEW).toBe('view');
    // No distinct `execute` verb exists in the catalog union; `run` is the bound verb.
    expect(PAYMENTS_EXECUTE).toBe('run');
  });
});

describe('money-movement gate — unprivileged members are DENIED', () => {
  // The legacy gate is what governs today (payments key pending in the RESERVED
  // catalog). Recording a customer payment falls back to invoices:create.
  it('denies business_user (external) from moving money', () => {
    const res = permissionDenied('business_user', 'invoices', 'create');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('denies general_admin (data entry) from moving money', () => {
    const res = permissionDenied('general_admin', 'invoices', 'create');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('denies unprivileged members on the dedicated payments key too', () => {
    for (const role of ['business_user', 'general_admin'] as const) {
      expect(permissionDenied(role, PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).not.toBeNull();
    }
  });
});

describe('money-movement gate — privileged approvers keep access (legacy gate)', () => {
  it('allows accounting_manager and company_admin to move money', () => {
    expect(permissionDenied('accounting_manager', 'invoices', 'create')).toBeNull();
    expect(permissionDenied('company_admin', 'invoices', 'create')).toBeNull();
  });
});

describe('dedicated payments key — fails CLOSED until the reserved catalog adopts it', () => {
  it('denies even company_admin on an unadopted feature (why the fallback exists)', () => {
    if (!paymentsFeatureInCatalog()) {
      // Feature absent from FEATURE_CATALOG → hasPermission returns false for every
      // role, so requireMoneyMovement() MUST fall back to the legacy gate.
      expect(permissionDenied('company_admin', PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).not.toBeNull();
    } else {
      // Once the lead lands the catalog change: execute allowed for a privileged
      // role, denied for an unprivileged one.
      expect(permissionDenied('company_admin', PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).toBeNull();
      expect(permissionDenied('business_user', PAYMENTS_FEATURE, PAYMENTS_EXECUTE)).not.toBeNull();
    }
  });
});
