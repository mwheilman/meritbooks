/**
 * DOLLAR LIMITS (05-RBAC-SPEC §3.4) — pure helpers over the wave-1 effective-access model.
 *
 * Limits are NOT a separate table: they are the `amount_limit` constraint on a grant
 * (role / permission-set grant, tightened by an assignment's `constraint_overrides`).
 * When several grants match, the request passes if ANY passes, and the effective limit
 * is the HIGHEST among passing grants (05 §3) — `can()` in effective-access.ts already
 * implements exactly that; these helpers only give it an approval-shaped API.
 *
 * Money is bigint cents carried as `number` (safe below 2^53 cents ≈ $90 trillion).
 */

import { parseCapabilityRef, type Action } from '@/lib/rbac/capabilities';
import {
  can,
  resolveEffectiveAccess,
  type AccessContext,
  type AccessSnapshot,
} from '@/lib/rbac/effective-access';

/** Accepts 'ap.bills:approve' or a bare resource key ('ap.bills' → approve). */
function parseRef(capability: string): { key: string; action: Action } | null {
  if (capability.includes(':')) return parseCapabilityRef(capability);
  return { key: capability, action: 'approve' };
}

export interface LimitResult {
  /** True when the holder may act on `amountCents` with this capability. */
  allowed: boolean;
  /** The holder's highest per-item limit for this capability (null = no limit). Only set when the capability is held at all. */
  limitCents: number | null;
  /** False when the capability isn't held at any amount. */
  held: boolean;
}

/**
 * Can this snapshot approve (or post / release) `amountCents` with `capability` in
 * `context`? `context` defaults to every assignment ('any'); pass a client context for a
 * client-owned document.
 */
export function approvalLimitCheck(
  snapshot: AccessSnapshot,
  capability: string,
  amountCents: number,
  context: AccessContext = { kind: 'any' },
  now: Date = new Date(),
): LimitResult {
  const ref = parseRef(capability);
  if (!ref) return { allowed: false, limitCents: null, held: false };
  const eff = resolveEffectiveAccess(snapshot, context, now);
  const atAll = can(eff, ref.key, ref.action);
  if (!atAll.allow) return { allowed: false, limitCents: null, held: false };
  const atAmount = can(eff, ref.key, ref.action, { amountCents: Math.max(0, amountCents) });
  return { allowed: atAmount.allow, limitCents: atAll.limitCents, held: true };
}

/** Shorthand: true when `snapshot` holds `capability` with a limit ≥ `amountCents`. */
export function withinApprovalLimit(
  snapshot: AccessSnapshot,
  capability: string,
  amountCents: number,
  context: AccessContext = { kind: 'any' },
  now: Date = new Date(),
): boolean {
  return approvalLimitCheck(snapshot, capability, amountCents, context, now).allowed;
}

/**
 * Does an approver satisfy a workflow step's floor (`min_approver_limit_cents`, 05 R-12)?
 * A null floor means any holder of the capability qualifies. An unlimited holder
 * (limitCents null) satisfies every floor.
 */
export function meetsApproverFloor(
  snapshot: AccessSnapshot,
  capability: string,
  floorCents: number | null,
  context: AccessContext = { kind: 'any' },
  now: Date = new Date(),
): boolean {
  return withinApprovalLimit(snapshot, capability, floorCents ?? 0, context, now);
}
