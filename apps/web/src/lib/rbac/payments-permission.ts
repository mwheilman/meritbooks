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

/** The coarse money-movement feature key (legacy superset). Every money route
 *  used to gate on this ONE key, so a check-runner could also release payroll — a
 *  Segregation-of-Duties gap (tasks #33/#56). It is retained as a degrade-safe
 *  superset the granular gate falls back to until the reserved catalog carries the
 *  per-route keys below (so nothing loosens mid-migration). */
export const PAYMENTS_FEATURE = 'payments';

/**
 * PER-ROUTE money-movement feature keys (SoD split, task #56). Each is its own
 * money-movement feature with its own EXECUTE action so a role can hold one
 * without holding the others (e.g. a check-runner gets `check_run` but NOT
 * `payroll_release`). These are gated on the moment the RESERVED permission
 * catalog (lib/rbac/permissions.ts) adopts them; until then every route degrades
 * to the coarse `payments` key (never looser than today) — see
 * requireMoneyMovement() below and the session report for the exact catalog diff.
 *
 *   payments_execute        — record a customer payment (cash in / AR).
 *   check_run               — queue AP disbursement approvals (front of the chain).
 *   ap_disbursement_release — RELEASE an approved AP batch (posts DR A/P / CR Cash).
 *   payroll_release         — release a payroll run to the provider (money out).
 */
export const PAYMENTS_EXECUTE_FEATURE = 'payments_execute';
export const CHECK_RUN_FEATURE = 'check_run';
export const AP_DISBURSEMENT_RELEASE_FEATURE = 'ap_disbursement_release';
export const PAYROLL_RELEASE_FEATURE = 'payroll_release';

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
  return featureInCatalog(PAYMENTS_FEATURE);
}

/** Is an arbitrary money-movement feature key present in the RESERVED catalog yet? */
export function featureInCatalog(featureId: string): boolean {
  return FEATURE_CATALOG.some((f) => f.id === featureId);
}

/**
 * Gate a money-movement route. Resolution is MOST-GRANULAR-FIRST and strictly
 * monotonic — each fallback is never looser than the one before, so the split can
 * land in production before the RESERVED catalog change without loosening any gate:
 *
 *   1. The per-route granular key (`specificFeature`, e.g. `payroll_release`), the
 *      moment lib/rbac/permissions.ts carries it → true Segregation of Duties (a
 *      check-runner can hold `check_run` yet be denied `payroll_release`).
 *   2. Else the coarse `payments` superset (today's live gate) → identical 403
 *      semantics to before the split; nothing loosens while the catalog backfills.
 *   3. Else, if neither key is catalogued, the route's legacy adjacent gate.
 *
 * Fails CLOSED at every tier — an unresolved role or org yields a 403 from
 * requirePermission.
 *
 *   const guard = await requireMoneyMovement(
 *     userId, PAYMENTS_EXECUTE,
 *     { feature: 'payroll', action: 'approve' },
 *     PAYROLL_RELEASE_FEATURE,
 *   );
 *   if (!guard.ok) return guard.response;
 */
export async function requireMoneyMovement(
  userId: string,
  action: FeatureAction,
  legacy: { feature: string; action: FeatureAction },
  specificFeature?: string,
): Promise<PermissionResult> {
  const { requirePermission } = await import('@/lib/rbac/require-permission');
  // 1. Most granular: the per-route money-movement key, once catalogued.
  if (specificFeature && featureInCatalog(specificFeature)) {
    return requirePermission(userId, specificFeature, action);
  }
  // 2. Degrade-safe superset: the coarse `payments` key (never looser than today).
  if (paymentsFeatureInCatalog()) {
    return requirePermission(userId, PAYMENTS_FEATURE, action);
  }
  // 3. Last resort while neither is catalogued: the route's legacy adjacent gate.
  return requirePermission(userId, legacy.feature, legacy.action);
}
