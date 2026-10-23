/**
 * CONFLICT RULES admin (05 §6.10 A10) — read model + tenant writes for the "Conflict
 * rules" panel. Service-role client only; callers authorize first. Every write is pinned
 * to the caller's verified org and re-checked against the pure rules in ./sod.ts, and
 * the DB triggers in migration 165 are the backstop (platform rules immutable, promotion
 * only, no exception on hard rules, H1).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { capabilityPhrase } from '@/lib/approvals/step-label';
import { parseCapabilityRef } from '@/lib/rbac/capabilities';
import {
  approverReleasePolicyOf,
  effectiveEnforcement,
  isApproverReleaseLoosening,
  tenantMayDisable,
  tenantMayPromote,
  type ApproverReleasePolicy,
  type SodEnforcement,
  type TenantType,
} from '@/lib/rbac/sod';
import { loadSodExceptions, loadSodRules, loadTenantSodSettings } from '@/lib/rbac/sod-store';
import { DEFAULT_DEPS, type EnforcementMode } from '@/lib/rbac/authorize';

type Row = Record<string, unknown>;

export interface ConflictRuleView {
  id: string;
  /** Internal rule code (never shown) — lets the screen attach per-rule status copy. */
  key: string;
  name: string;
  description: string;
  suggestedFix: string | null;
  /** 'always' = platform-locked transaction rule; 'per_item' = checked on each item; 'access' = role combination. */
  kind: 'always' | 'per_item' | 'access';
  owner: 'platform' | 'tenant';
  enforcement: SodEnforcement;
  status: 'active' | 'disabled';
  promoted: boolean;
  canPromote: boolean;
  canDisable: boolean;
}

export interface AllowedConflictView {
  id: string;
  ruleName: string;
  description: string;
  personName: string;
  clientName: string | null;
  justification: string;
  compensatingControl: string | null;
  approvedByName: string;
  expiresAt: string;
}

export interface ConflictRulesView {
  rules: ConflictRuleView[];
  allowedConflicts: AllowedConflictView[];
  settings: {
    tenantType: TenantType;
    soleApproverMode: boolean;
    /** Mig 174: may the approver also release — off / any amount / up to a limit. */
    approverRelease: ApproverReleasePolicy;
    jeSelfPostThresholdCents: number;
    /** The tenant's access mode — decides what the JE self-post rule does (je-post-sod-copy.ts). */
    accessMode: EnforcementMode | null;
  };
}

function personName(u: Row | undefined): string {
  if (!u) return 'Unknown person';
  const full = [u.first_name, u.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ');
  return full || (typeof u.email === 'string' ? u.email : 'Unknown person');
}

export async function coreUserIdFor(admin: SupabaseClient, clerkUserId: string): Promise<string | null> {
  const { data } = await admin.schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  return (data as Row | null)?.id ? String((data as Row).id) : null;
}

export async function loadConflictRulesView(admin: SupabaseClient, orgId: string): Promise<ConflictRulesView> {
  const [rules, settings, exceptions, accessMode] = await Promise.all([
    loadSodRules(admin, orgId),
    loadTenantSodSettings(admin, orgId),
    loadSodExceptions(admin, orgId),
    DEFAULT_DEPS.mode(orgId).catch(() => null),
  ]);
  const now = Date.now();
  const live = exceptions.filter((e) => new Date(e.expiresAt).getTime() > now);

  const membershipIds = [...new Set(live.map((e) => e.membershipId))];
  const locationIds = [...new Set(live.map((e) => e.locationId).filter((x): x is string => !!x))];
  const [{ data: memberships }, { data: locations }] = await Promise.all([
    membershipIds.length
      ? admin.schema('core').from('memberships').select('id, user_id').eq('org_id', orgId).in('id', membershipIds)
      : Promise.resolve({ data: [] as Row[] }),
    locationIds.length
      ? admin.schema('core').from('locations').select('id, name').eq('org_id', orgId).in('id', locationIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);
  const userIds = [
    ...new Set([
      ...((memberships ?? []) as Row[]).map((m) => String(m.user_id)),
      ...live.map((e) => e.approvedBy),
    ]),
  ];
  const { data: users } = userIds.length
    ? await admin.schema('core').from('users').select('id, email, first_name, last_name').in('id', userIds)
    : { data: [] as Row[] };
  const userById = new Map(((users ?? []) as Row[]).map((u) => [String(u.id), u]));
  const userOfMembership = new Map(((memberships ?? []) as Row[]).map((m) => [String(m.id), String(m.user_id)]));
  const locName = new Map(((locations ?? []) as Row[]).map((l) => [String(l.id), String(l.name)]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  return {
    rules: rules.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      suggestedFix: r.suggestedFix,
      kind: r.platformLocked ? 'always' : r.enforcement === 'txn_only' ? 'per_item' : 'access',
      owner: r.orgId ? 'tenant' : 'platform',
      enforcement: effectiveEnforcement(r, settings),
      status: r.status,
      promoted: settings.promotedRuleIds.has(r.id),
      canPromote: tenantMayPromote(r) && r.tenantTypeOverride[settings.tenantType] !== 'hard',
      canDisable: tenantMayDisable(r, orgId),
    })),
    allowedConflicts: live.map((e) => {
      const rule = ruleById.get(e.ruleId);
      return {
        id: e.id,
        ruleName: rule?.name ?? 'Conflict rule',
        description: rule?.description ?? '',
        personName: personName(userById.get(userOfMembership.get(e.membershipId) ?? '')),
        clientName: e.locationId ? locName.get(e.locationId) ?? 'A client' : null,
        justification: e.justification,
        compensatingControl: e.compensatingControl,
        approvedByName: personName(userById.get(e.approvedBy)),
        expiresAt: e.expiresAt,
      };
    }),
    settings: {
      tenantType: settings.tenantType,
      soleApproverMode: settings.soleApproverMode,
      approverRelease: approverReleasePolicyOf(settings.soleApproverMode, settings.soleApproverMaxCents),
      jeSelfPostThresholdCents: settings.jeSelfPostThresholdCents,
      accessMode,
    },
  };
}

export class ConflictRuleError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = 'ConflictRuleError';
    this.status = status;
  }
}

/** "Could both approve bills and release payment runs." from two capability refs. */
export function sentenceForPair(a: string, b: string): string {
  return `Could both ${capabilityPhrase(a)} and ${capabilityPhrase(b)}.`;
}

export async function createTenantRule(
  admin: SupabaseClient,
  orgId: string,
  input: { first: string; second: string; enforcement: 'soft' | 'hard'; suggestedFix?: string | null; createdBy: string | null },
): Promise<string> {
  if (!parseCapabilityRef(input.first) || !parseCapabilityRef(input.second)) {
    throw new ConflictRuleError('Pick two permissions from the list.');
  }
  if (input.first === input.second) throw new ConflictRuleError('Pick two different permissions.');
  const description = sentenceForPair(input.first, input.second);
  const key = `T_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase();
  const { data, error } = await admin
    .schema('core')
    .from('sod_rules')
    .insert({
      org_id: orgId,
      key,
      rule_type: 'role',
      name: description.replace(/^Could both /, 'Both ').replace(/\.$/, ''),
      description,
      suggested_fix: input.suggestedFix?.trim() || 'Give these two permissions to different people.',
      conflict: [[input.first], [input.second]],
      enforcement: input.enforcement,
      created_by: input.createdBy,
      sort_order: 200,
    })
    .select('id')
    .single();
  if (error) throw new ConflictRuleError(error.message, 500);
  return String((data as Row).id);
}

/** Enable / disable a TENANT rule, or promote / un-promote a PLATFORM soft rule. */
export async function updateRule(
  admin: SupabaseClient,
  orgId: string,
  ruleId: string,
  patch: { status?: 'active' | 'disabled'; blocks?: boolean },
  actor: string | null,
): Promise<void> {
  const rules = await loadSodRules(admin, orgId);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new ConflictRuleError('Rule not found', 404);

  if (rule.orgId === null) {
    // Platform rule: tenants can never disable it; they may only make a soft rule block.
    if (patch.status !== undefined) throw new ConflictRuleError('MeritBooks safeguards can’t be turned off.', 403);
    if (patch.blocks === undefined) return;
    if (!tenantMayPromote(rule)) throw new ConflictRuleError('This safeguard can’t be changed.', 403);
    if (patch.blocks) {
      const { error } = await admin
        .schema('core')
        .from('sod_rule_settings')
        .upsert({ org_id: orgId, rule_id: ruleId, enforcement: 'hard', updated_by: actor }, { onConflict: 'org_id,rule_id' });
      if (error) throw new ConflictRuleError(error.message, 500);
    } else {
      const { error } = await admin.schema('core').from('sod_rule_settings').delete().eq('org_id', orgId).eq('rule_id', ruleId);
      if (error) throw new ConflictRuleError(error.message, 500);
    }
    return;
  }

  // Tenant rule.
  const update: Row = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.blocks !== undefined) update.enforcement = patch.blocks ? 'hard' : 'soft';
  if (Object.keys(update).length === 0) return;
  const { error } = await admin.schema('core').from('sod_rules').update(update).eq('org_id', orgId).eq('id', ruleId);
  if (error) throw new ConflictRuleError(error.message, 500);
}

export async function updateSodSettings(
  admin: SupabaseClient,
  orgId: string,
  patch: { jeSelfPostThresholdCents?: number },
): Promise<void> {
  if (patch.jeSelfPostThresholdCents === undefined) return;
  const { error } = await admin
    .schema('core')
    .from('organizations')
    .update({ je_self_post_threshold_cents: patch.jeSelfPostThresholdCents })
    .eq('id', orgId);
  if (error) throw new ConflictRuleError(error.message, 500);
}

// ── Approver-release policy (mig 174) ───────────────────────────────────────────

export interface ApproverReleaseChangePlan {
  current: ApproverReleasePolicy;
  next: ApproverReleasePolicy;
  unchanged: boolean;
  /** Relaxes the rule → the session must meet the tenant's CURRENT security policy first. */
  loosening: boolean;
}

/** Normalize the requested policy and compare it with the stored one. Pure apart from the read. */
export async function planApproverReleaseChange(
  admin: SupabaseClient,
  orgId: string,
  requested: ApproverReleasePolicy,
): Promise<ApproverReleaseChangePlan> {
  const settings = await loadTenantSodSettings(admin, orgId);
  const current = approverReleasePolicyOf(settings.soleApproverMode, settings.soleApproverMaxCents);
  const next: ApproverReleasePolicy = requested.choice === 'up_to'
    ? { choice: 'up_to', maxCents: requested.maxCents }
    : { choice: requested.choice, maxCents: null };
  if (next.choice !== 'off' && settings.tenantType === 'firm') {
    throw new ConflictRuleError('One-person approval isn’t available for firms.', 403);
  }
  if (next.choice === 'up_to' && (next.maxCents == null || next.maxCents <= 0)) {
    throw new ConflictRuleError('Enter an amount greater than $0.', 422);
  }
  const unchanged = current.choice === next.choice && current.maxCents === next.maxCents;
  return { current, next, unchanged, loosening: !unchanged && isApproverReleaseLoosening(current, next) };
}

/**
 * Apply through core.set_approver_release_policy (service role only): the DB re-checks
 * tenant admin, firm, and — re-deriving loosening itself — refuses a loosening unless
 * `sessionPolicyMet` is attested. The change is written to core.access_change_log by
 * the organizations trigger (mig 174 §4).
 */
export async function applyApproverReleaseChange(
  admin: SupabaseClient,
  orgId: string,
  next: ApproverReleasePolicy,
  opts: { actorUserId: string; sessionPolicyMet: boolean; reason?: string | null; ip?: string | null },
): Promise<void> {
  const { error } = await admin.schema('core').rpc('set_approver_release_policy', {
    p_org: orgId,
    p_choice: next.choice,
    p_max_cents: next.choice === 'up_to' ? next.maxCents : null,
    p_actor: opts.actorUserId,
    p_session_policy_met: opts.sessionPolicyMet,
    p_reason: opts.reason ?? null,
    p_ip: opts.ip ?? null,
  });
  if (!error) return;
  if (error.code === '42883' || error.code === 'PGRST202') {
    throw new ConflictRuleError('This setting isn’t available yet (migration 174).', 503);
  }
  if (error.code === '42501') throw new ConflictRuleError(error.message, 403);
  if (error.code === '23514') throw new ConflictRuleError(error.message, 422);
  throw new ConflictRuleError(error.message, 500);
}

/** Plain-English one-liner for logs / toasts. */
export function describeApproverRelease(p: ApproverReleasePolicy, money: (cents: number) => string): string {
  if (p.choice === 'off') return 'The approver of a payment can never release it';
  if (p.choice === 'any') return 'The approver may also release payments of any amount';
  return `The approver may also release payments up to ${money(p.maxCents ?? 0)}`;
}
