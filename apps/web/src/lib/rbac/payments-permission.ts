/**
 * Dedicated money-movement (payments) permission — identity/RBAC gate #9, task #33.
 *
 * CANON §3: "Money-movement authorization must reconcile to Core identity ...
 * Do NOT bake a Books-private 'who may approve' that won't reconcile." Today the
 * money routes BORROW an adjacent feature's permission (record-payment →
 * `invoices:create`, check run → `checks:create`, payroll release →
 * `payroll:approve`). That is the residual this module closes: it introduces the
 * single `payments` feature key every money-movement route gates on, so the
 * reserved permission catalog (`lib/rbac/permissions.ts`) can adopt it in ONE
 * place and every money route inherits the tightened grant.
 *
 * `lib/rbac/permissions.ts` is a RESERVED spine file this agent may not edit. The
 * EXACT addition for the lead to apply is documented in the session report:
 *
 *   FEATURE_CATALOG += {
 *     id: 'payments', name: 'Payments / money movement',
 *     category: 'Finance & reporting', actions: ['view', 'run'], internalOnly: true,
 *   }
 *   // grant on each role's features map:
 *   //   execute (view+run): company_admin, cfo, merit_controller,
 *   //                       assistant_cfo, accounting_manager
 *   //   view only:          accounting_specialist
 *   //   (check_processor:   view+run IF checks-only execute is desired — Owner call)
 *   //   withheld entirely:  general_admin, business_user
 *
 * `run` is the catalog's existing execute verb (the `FeatureAction` union has no
 * distinct `execute`); binding `PAYMENTS_EXECUTE` to it keeps this typed against
 * the reserved catalog untouched.
 *
 * TRANSITIONAL FALLBACK: until that catalog entry exists, gating directly on
 * `payments` would deny EVERY role (hasPermission fails closed on an unknown
 * feature) and break production money movement. So `requireMoneyMovement()` gates
 * on the new `payments` key the moment the catalog carries it, and otherwise falls
 * back to the route's legacy permission — the wiring is live-ready with zero
 * downtime and flips authority the instant the lead lands the catalog change.
 */

import type { FeatureAction } from '@/lib/rbac/permissions';
import { FEATURE_CATALOG } from '@/lib/rbac/permissions';
import type { PermissionResult } from '@/lib/rbac/require-permission';

/** The single money-movement feature key every money route gates on. */
export const PAYMENTS_FEATURE = 'payments';

/** View the money-movement surface (queues, run history, connect status). */
export const PAYMENTS_VIEW: FeatureAction = 'view';

/**
 * EXECUTE money movement — record a payment, run checks, release payroll. Bound to
 * the catalog's existing `run` verb; there is no distinct `execute` action in the
 * `FeatureAction` union, so `run` is the execute verb the lead adds for `payments`.
 */
export const PAYMENTS_EXECUTE: FeatureAction = 'run';

/** Has the reserved catalog adopted the dedicated `payments` feature yet? */
export function paymentsFeatureInCatalog(): boolean {
  return FEATURE_CATALOG.some((f) => f.id === PAYMENTS_FEATURE);
}

/**
 * Gate a money-movement route. Uses the dedicated `payments` permission once the
 * reserved catalog carries it; until then falls back to the route's legacy gate so
 * nothing breaks while the (RESERVED) catalog change is pending. Fails CLOSED
 * either way — an unresolved role or org yields a 403 from requirePermission.
 *
 *   const guard = await requireMoneyMovement(userId, PAYMENTS_EXECUTE, {
 *     feature: 'invoices', action: 'create',
 *   });
 *   if (!guard.ok) return guard.response;
 */
export async function requireMoneyMovement(
  userId: string,
  action: FeatureAction,
  legacy: { feature: string; action: FeatureAction },
): Promise<PermissionResult> {
  const { requirePermission } = await import('@/lib/rbac/require-permission');
  if (paymentsFeatureInCatalog()) {
    return requirePermission(userId, PAYMENTS_FEATURE, action);
  }
  return requirePermission(userId, legacy.feature, legacy.action);
}
