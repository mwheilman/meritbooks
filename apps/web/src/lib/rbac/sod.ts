/**
 * SEPARATION OF DUTIES — the pure decision layer (05-RBAC-SPEC §4.1 H1/H6, §4.3, R-8).
 *
 * Two kinds of check, both deterministic and side-effect free:
 *
 *   1. ASSIGNMENT-TIME (static, role-level). A conflict rule lists two or more "legs" of
 *      capabilities; it fires when ONE person holds every leg on the SAME client in their
 *      EFFECTIVE set (roles + permission sets − mutes − read-only, 05 §4.3). Granting a
 *      role / permission set that CREATES a new conflict is:
 *        - hard  → blocked (no exception possible);
 *        - soft  → blocked unless an active allowed conflict (sod_exceptions row) covers
 *                  it, or the grantor supplies a written justification (which the caller
 *                  then records as a new allowed conflict);
 *        - txn_only → never blocks a grant (checked per item instead).
 *      Conflicts the person already had before the change are reported, not re-blocked.
 *
 *   2. ACTION-TIME (transaction-level, H6 — platform-locked, tenants can't disable):
 *      `assertActionSod` generalizes the money-movement preparer ≠ approver ≠ releaser
 *      rule to every approve / release / post / sign-off.
 *
 * Rule codes (S1…S9, H6_*) are INTERNAL. Every message produced here is the rule's plain
 * sentence ("Could both create vendors and release payments to them") — never a code.
 *
 * DB loading / writes live in ./sod-store.ts. The SQL twin of `detectConflicts` is
 * core.sod_conflicts_for_membership (migration 165) — the test suite proves they agree.
 */

import type { Action } from '@/lib/rbac/capabilities';
import {
  capabilityMap,
  resolveEffectiveAccess,
  type AccessContext,
  type AccessSnapshot,
  type AssignmentInput,
} from '@/lib/rbac/effective-access';

// ── Types ─────────────────────────────────────────────────────────────────────────

export type SodEnforcement = 'soft' | 'hard' | 'txn_only';
export type SodRuleType = 'role' | 'transaction';
export type TenantType = 'firm' | 'company';

export interface SodRule {
  id: string;
  /** null = platform rule (immutable to tenants). */
  orgId: string | null;
  /** Internal code — stored and logged, never shown. */
  key: string;
  ruleType: SodRuleType;
  name: string;
  /** One plain sentence: what a person holding the conflict could do. */
  description: string;
  suggestedFix: string | null;
  /** Role rules: every leg must be held; each leg is a list of 'cap:action' alternatives ('*:action' = any). */
  legs: string[][];
  enforcement: SodEnforcement;
  tenantTypeOverride: Partial<Record<TenantType, 'soft' | 'hard'>>;
  platformLocked: boolean;
  status: 'active' | 'disabled';
  sortOrder: number;
}

export interface SodException {
  id: string;
  ruleId: string;
  membershipId: string;
  /** null = every client. */
  locationId: string | null;
  justification: string;
  compensatingControl: string | null;
  approvedBy: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SodPolicy {
  tenantType: TenantType;
  /** Platform rule ids the tenant promoted soft → hard. */
  promotedRuleIds: ReadonlySet<string>;
}

export interface SodConflict {
  ruleId: string;
  ruleKey: string;
  name: string;
  /** Plain sentence for the UI. */
  description: string;
  suggestedFix: string | null;
  enforcement: SodEnforcement;
  /** Client the conflict exists on; null = tenant-level context. */
  locationId: string | null;
  /** The concrete 'cap:action' that satisfied each leg. */
  matched: string[];
  /** Active allowed conflict covering this, if any. */
  exceptionId: string | null;
  exceptionExpiresAt: string | null;
}

// ── Enforcement ─────────────────────────────────────────────────────────────────

/** Strictest of base, tenant-type override and tenant promotion (05 §4.3). */
export function effectiveEnforcement(rule: SodRule, policy: SodPolicy): SodEnforcement {
  if (rule.enforcement === 'hard' || rule.enforcement === 'txn_only') return rule.enforcement;
  if (rule.tenantTypeOverride[policy.tenantType] === 'hard') return 'hard';
  if (policy.promotedRuleIds.has(rule.id)) return 'hard';
  return rule.enforcement;
}

/** Whether a tenant may change a rule at all (platform rules are never disabled). */
export function tenantMayDisable(rule: SodRule, orgId: string): boolean {
  return rule.orgId === orgId && rule.ruleType === 'role';
}

/** Whether a tenant may promote a platform soft rule to hard. */
export function tenantMayPromote(rule: SodRule): boolean {
  return rule.orgId === null && rule.ruleType === 'role' && rule.enforcement === 'soft' && !rule.platformLocked;
}

// ── Effective set + detection ───────────────────────────────────────────────────

/** Effective 'cap:action' set of a snapshot in one context (after narrowing + ceilings). */
export function effectiveCapabilitySet(snapshot: AccessSnapshot, ctx: AccessContext, now: Date = new Date()): Set<string> {
  const out = new Set<string>();
  const add = (eff: ReturnType<typeof resolveEffectiveAccess>) => {
    for (const [cap, actions] of Object.entries(capabilityMap(eff))) {
      for (const a of actions) out.add(`${cap}:${a}`);
    }
  };
  add(resolveEffectiveAccess(snapshot, ctx, now));
  // Tenant-scoped grants (access admin, settings) apply to the person everywhere.
  if (ctx.kind === 'client') add(resolveEffectiveAccess(snapshot, { kind: 'tenant' }, now));
  return out;
}

function legHit(leg: readonly string[], set: ReadonlySet<string>): string | null {
  const sorted = [...set].sort();
  for (const alt of leg) {
    const [cap, action] = alt.split(':');
    if (cap === '*') {
      const hit = sorted.find((s) => s.split(':')[1] === action);
      if (hit) return hit;
    } else if (set.has(alt)) {
      return alt;
    }
  }
  return null;
}

/** Which role rules does this set trigger? Returns matched alternatives per leg. */
export function matchRules(rules: readonly SodRule[], set: ReadonlySet<string>): Array<{ rule: SodRule; matched: string[] }> {
  const out: Array<{ rule: SodRule; matched: string[] }> = [];
  for (const rule of rules) {
    if (rule.ruleType !== 'role' || rule.status !== 'active' || rule.legs.length < 2) continue;
    const matched: string[] = [];
    let ok = true;
    for (const leg of rule.legs) {
      const hit = legHit(leg, set);
      if (!hit) {
        ok = false;
        break;
      }
      matched.push(hit);
    }
    if (ok) out.push({ rule, matched });
  }
  return out.sort((a, b) => a.rule.sortOrder - b.rule.sortOrder || a.rule.key.localeCompare(b.rule.key));
}

function activeException(
  exceptions: readonly SodException[],
  membershipId: string,
  ruleId: string,
  locationId: string | null,
  now: Date,
): SodException | null {
  const live = exceptions.filter(
    (e) =>
      e.membershipId === membershipId &&
      e.ruleId === ruleId &&
      !e.revokedAt &&
      new Date(e.expiresAt).getTime() > now.getTime() &&
      (e.locationId === null || e.locationId === locationId),
  );
  live.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
  return live[0] ?? null;
}

/** Client contexts a snapshot can act on (all org clients when any all-clients grant is active). */
export function snapshotLocations(snapshot: AccessSnapshot, orgLocationIds: readonly string[], now: Date = new Date()): string[] {
  const active = snapshot.assignments.filter(
    (a) =>
      a.status === 'active' &&
      (!a.effectiveFrom || new Date(a.effectiveFrom).getTime() <= now.getTime()) &&
      (!a.effectiveTo || new Date(a.effectiveTo).getTime() > now.getTime()),
  );
  if (active.some((a) => a.scopeType === 'all_clients')) return [...orgLocationIds].sort();
  const locs = new Set<string>();
  for (const a of active) {
    if (a.scopeType === 'client' && a.locationId) locs.add(a.locationId);
    if (a.scopeType === 'client_set') a.clientSetLocationIds.forEach((l) => locs.add(l));
  }
  return [...locs].sort();
}

export interface DetectOptions {
  rules: readonly SodRule[];
  policy: SodPolicy;
  exceptions: readonly SodException[];
  /** Every client of the tenant (for all-clients assignments). */
  orgLocationIds: readonly string[];
  now?: Date;
}

/** Every role-rule conflict in a snapshot, per client. Mirrors core.sod_conflicts_for_membership. */
export function detectConflicts(snapshot: AccessSnapshot, opts: DetectOptions): SodConflict[] {
  const now = opts.now ?? new Date();
  if (snapshot.membership.status !== 'active') return [];
  const locs = snapshotLocations(snapshot, opts.orgLocationIds, now);
  const contexts: Array<string | null> = locs.length > 0 ? locs : [null];
  const out: SodConflict[] = [];
  for (const loc of contexts) {
    const ctx: AccessContext = loc ? { kind: 'client', locationId: loc } : { kind: 'tenant' };
    const set = effectiveCapabilitySet(snapshot, ctx, now);
    for (const { rule, matched } of matchRules(opts.rules, set)) {
      const ex = activeException(opts.exceptions, snapshot.membership.id, rule.id, loc, now);
      out.push({
        ruleId: rule.id,
        ruleKey: rule.key,
        name: rule.name,
        description: rule.description,
        suggestedFix: rule.suggestedFix,
        enforcement: effectiveEnforcement(rule, opts.policy),
        locationId: loc,
        matched,
        exceptionId: ex?.id ?? null,
        exceptionExpiresAt: ex?.expiresAt ?? null,
      });
    }
  }
  return out;
}

// ── Assignment-time check ───────────────────────────────────────────────────────

export interface AssignmentSodInput extends DetectOptions {
  /** The person's current access (null = a brand-new member with no grants). */
  current: AccessSnapshot;
  /** Assignments being added or replaced (matched by id; same id = replacement). */
  proposed: readonly AssignmentInput[];
  /** Assignment ids being removed in the same change. */
  removedIds?: readonly string[];
  /** Grantor's written reason for allowing soft conflicts (05 §4.3). */
  justification?: string | null;
}

export interface AssignmentSodResult {
  /** True when the change may be written. */
  allowed: boolean;
  /** New hard conflicts — always block. */
  blocked: SodConflict[];
  /** New soft conflicts with no exception and no justification — block until a reason is given. */
  needsJustification: SodConflict[];
  /** New soft conflicts the caller must record as allowed conflicts (justification supplied). */
  toRecord: SodConflict[];
  /** New conflicts already covered by an active allowed conflict. */
  covered: SodConflict[];
  /** Conflicts the person already had (not created by this change). */
  existing: SodConflict[];
  /** One plain-English line per blocking conflict, for the UI / API error. */
  messages: string[];
}

const conflictKey = (c: Pick<SodConflict, 'ruleId' | 'locationId'>) => `${c.ruleId}@${c.locationId ?? '*'}`;

/** Minimum justification length (matches the DB check on core.sod_exceptions). */
export const MIN_JUSTIFICATION_LENGTH = 10;

export function checkAssignmentSod(input: AssignmentSodInput): AssignmentSodResult {
  const removed = new Set([...(input.removedIds ?? []), ...input.proposed.map((p) => p.id)]);
  const after: AccessSnapshot = {
    ...input.current,
    assignments: [...input.current.assignments.filter((a) => !removed.has(a.id)), ...input.proposed],
  };
  const before = detectConflicts(input.current, input);
  const beforeKeys = new Set(before.map(conflictKey));
  const afterConflicts = detectConflicts(after, input);
  const fresh = afterConflicts.filter((c) => !beforeKeys.has(conflictKey(c)) && c.enforcement !== 'txn_only');
  const existing = afterConflicts.filter((c) => beforeKeys.has(conflictKey(c)));

  const justified = (input.justification ?? '').trim().length >= MIN_JUSTIFICATION_LENGTH;
  const blocked = fresh.filter((c) => c.enforcement === 'hard');
  const covered = fresh.filter((c) => c.enforcement === 'soft' && c.exceptionId);
  const softOpen = fresh.filter((c) => c.enforcement === 'soft' && !c.exceptionId);
  const needsJustification = justified ? [] : softOpen;
  const toRecord = justified ? softOpen : [];

  return {
    allowed: blocked.length === 0 && needsJustification.length === 0,
    blocked,
    needsJustification,
    toRecord,
    covered,
    existing,
    messages: [...blocked, ...needsJustification].map((c) => conflictMessage(c)),
  };
}

/** Plain-English line for a conflict, optionally naming the client. */
export function conflictMessage(c: Pick<SodConflict, 'description' | 'enforcement' | 'suggestedFix'>, clientName?: string | null): string {
  const where = clientName ? ` on ${clientName}` : '';
  const lead = c.enforcement === 'hard' ? 'Not allowed' : 'Needs a reason';
  const fix = c.suggestedFix ? ` ${c.suggestedFix}` : '';
  return `${lead}${where}: ${c.description}${fix}`;
}

// ── Action-time check (H6 — platform-locked) ─────────────────────────────────────

export type SodAction = 'approve' | 'release' | 'post' | 'sign_off';

export type ActionSodCode =
  | 'PREPARER_CANNOT_APPROVE'
  | 'PREPARER_CANNOT_RELEASE'
  | 'APPROVER_CANNOT_RELEASE'
  | 'PREPARER_CANNOT_POST'
  | 'PREPARER_CANNOT_SIGN_OFF'
  | 'RECENT_BANK_DETAIL_CHANGE';

/** Internal rule key behind each code (for logs; never shown). */
export const ACTION_SOD_RULE_KEY: Record<ActionSodCode, string> = {
  PREPARER_CANNOT_APPROVE: 'H6_PREPARER_APPROVER',
  PREPARER_CANNOT_RELEASE: 'H6_PREPARER_RELEASER',
  APPROVER_CANNOT_RELEASE: 'H6_APPROVER_RELEASER',
  PREPARER_CANNOT_POST: 'H6_JE_SELF_POST',
  PREPARER_CANNOT_SIGN_OFF: 'S9',
  RECENT_BANK_DETAIL_CHANGE: 'H6_BANK_CHANGE_RELEASE',
};

export const ACTION_SOD_MESSAGE: Record<ActionSodCode, string> = {
  PREPARER_CANNOT_APPROVE: 'You prepared this, so someone else has to approve it.',
  PREPARER_CANNOT_RELEASE: 'You prepared this payment, so someone else has to release it.',
  APPROVER_CANNOT_RELEASE: 'You approved this payment, so someone else has to release it.',
  PREPARER_CANNOT_POST: 'You prepared this journal entry and it is at or above the self-post amount, so someone else has to post it.',
  PREPARER_CANNOT_SIGN_OFF: 'You prepared this reconciliation, so someone else has to sign it off.',
  RECENT_BANK_DETAIL_CHANGE: "You changed or approved this vendor's bank details in the last 10 days, so someone else has to release payments to it.",
};

export class SodViolationError extends Error {
  readonly code: ActionSodCode;
  readonly ruleKey: string;
  constructor(code: ActionSodCode) {
    super(ACTION_SOD_MESSAGE[code]);
    this.name = 'SodViolationError';
    this.code = code;
    this.ruleKey = ACTION_SOD_RULE_KEY[code];
  }
}

export interface ActionSodInput {
  /** clerk_user_id acting now. */
  actor: string;
  action: SodAction;
  preparedBy: string | null | undefined;
  approvedBy?: string | null;
  /** Q1: approver may also release. Never lets the preparer act. */
  soleApproverMode?: boolean;
  /** For action 'post' on manual JEs: amount + tenant threshold (Q4). Omit to always enforce. */
  amountCents?: number;
  jeSelfPostThresholdCents?: number;
  /** System-generated entries (bank coding, depreciation, rev rec runs) are exempt from the JE rule. */
  systemGenerated?: boolean;
  /** For 'release': who changed / approved the payee's bank details, and when (ISO). */
  bankDetailChanges?: ReadonlyArray<{ userId: string; at: string }>;
  now?: Date;
}

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

/** Returns the first violated hard rule, or null. Pure. */
export function checkActionSod(input: ActionSodInput): ActionSodCode | null {
  const { actor, action } = input;
  const prepared = input.preparedBy ?? null;
  const isPreparer = prepared !== null && prepared === actor;
  switch (action) {
    case 'approve':
      return isPreparer ? 'PREPARER_CANNOT_APPROVE' : null;
    case 'sign_off':
      return isPreparer ? 'PREPARER_CANNOT_SIGN_OFF' : null;
    case 'post': {
      if (!isPreparer || input.systemGenerated) return null;
      if (input.amountCents !== undefined && input.jeSelfPostThresholdCents !== undefined) {
        return Math.abs(input.amountCents) >= input.jeSelfPostThresholdCents ? 'PREPARER_CANNOT_POST' : null;
      }
      return 'PREPARER_CANNOT_POST';
    }
    case 'release': {
      if (isPreparer) return 'PREPARER_CANNOT_RELEASE';
      if (input.approvedBy && input.approvedBy === actor && !input.soleApproverMode) return 'APPROVER_CANNOT_RELEASE';
      const now = (input.now ?? new Date()).getTime();
      const recent = (input.bankDetailChanges ?? []).some(
        (c) => c.userId === actor && now - new Date(c.at).getTime() < TEN_DAYS_MS,
      );
      return recent ? 'RECENT_BANK_DETAIL_CHANGE' : null;
    }
  }
}

/** Throws SodViolationError on a hard transaction-level SoD violation (05 §4.1 H6). */
export function assertActionSod(input: ActionSodInput): void {
  const code = checkActionSod(input);
  if (code) throw new SodViolationError(code);
}

// ── Row mapping (shared by store + API) ─────────────────────────────────────────

export interface SodRuleRow {
  id: string;
  org_id: string | null;
  key: string;
  rule_type: string;
  name: string;
  description: string;
  suggested_fix: string | null;
  conflict: unknown;
  enforcement: string;
  tenant_type_override: Record<string, string> | null;
  platform_locked: boolean;
  status: string;
  sort_order: number;
}

export function toSodRule(r: SodRuleRow): SodRule {
  const legs = Array.isArray(r.conflict)
    ? (r.conflict as unknown[]).filter(Array.isArray).map((leg) => (leg as unknown[]).map(String))
    : [];
  const override: SodRule['tenantTypeOverride'] = {};
  for (const [k, v] of Object.entries(r.tenant_type_override ?? {})) {
    if ((k === 'firm' || k === 'company') && (v === 'soft' || v === 'hard')) override[k] = v;
  }
  return {
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    ruleType: r.rule_type === 'transaction' ? 'transaction' : 'role',
    name: r.name,
    description: r.description,
    suggestedFix: r.suggested_fix,
    legs,
    enforcement: r.enforcement === 'hard' || r.enforcement === 'txn_only' ? r.enforcement : 'soft',
    tenantTypeOverride: override,
    platformLocked: r.platform_locked,
    status: r.status === 'disabled' ? 'disabled' : 'active',
    sortOrder: r.sort_order,
  };
}

/** Plain-English label for a 'cap:action' ref (for tenant-rule authoring UI). */
export function isActionRef(ref: string): ref is `${string}:${Action}` {
  return /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)+):(view|create|edit|delete|approve|post|release|export|configure)$/.test(ref);
}
