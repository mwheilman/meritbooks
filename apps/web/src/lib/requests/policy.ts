/**
 * Tenant request policies: code defaults ← core.request_policies rows (null = inherit).
 *
 * Receipt chase is the exception: its cadence, escalation, quiet hours and channel come
 * from the EXISTING Settings → Receipt chase values (core.organizations.chase_*), so
 * there is one source of truth for them and nothing that tab saves is ignored.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { quietHoursOf, resolveTimeZone } from './cadence';
import type { Cadence, Channel, PolicyKey, QuietHours, RequestKind } from './types';
import { POLICY_KEYS, isChannel } from './types';

const DAY = 1440;

export interface ResolvedPolicy {
  key: PolicyKey | 'receipt';
  label: string;
  cadence: Cadence;
  anchor: 'created' | 'due';
  escalateAfter: number | null;
  channels: Channel[];
  quiet: QuietHours | null;
  timezone: string;
  /** Create requests automatically from the books (vendor sync etc.). */
  autoCreate: boolean;
  /** Where the values come from, for the settings card. */
  source: 'default' | 'tenant' | 'receipt_settings';
}

interface DefaultSpec {
  label: string;
  anchor: 'created' | 'due';
  offsets: number[];
  repeat: number | null;
  max: number;
  escalateAfter: number | null;
  channels: Channel[];
}

export const POLICY_DEFAULTS: Record<Exclude<PolicyKey, 'default'>, DefaultSpec> = {
  w9: { label: 'W-9 (missing)', anchor: 'created', offsets: [0, 3 * DAY, 7 * DAY], repeat: 7 * DAY, max: 10, escalateAfter: 3, channels: ['email'] },
  coi: { label: 'Certificate of insurance (missing)', anchor: 'created', offsets: [0, 3 * DAY, 7 * DAY], repeat: 7 * DAY, max: 10, escalateAfter: 3, channels: ['email'] },
  coi_renewal: { label: 'Certificate of insurance (renewal)', anchor: 'due', offsets: [-30 * DAY, -15 * DAY, 0], repeat: 7 * DAY, max: 10, escalateAfter: 3, channels: ['email'] },
  client_question: { label: 'Client question', anchor: 'created', offsets: [0, 2 * DAY, 5 * DAY], repeat: 7 * DAY, max: 6, escalateAfter: 3, channels: ['email', 'in_app'] },
  document: { label: 'Document request', anchor: 'created', offsets: [0, 3 * DAY, 7 * DAY], repeat: 7 * DAY, max: 6, escalateAfter: 3, channels: ['email', 'in_app'] },
  approval_nudge: { label: 'Approval nudge', anchor: 'created', offsets: [0, 1 * DAY], repeat: 1 * DAY, max: 5, escalateAfter: 2, channels: ['in_app', 'email'] },
  dunning: { label: 'Payment reminder (dunning)', anchor: 'due', offsets: [0, 7 * DAY, 15 * DAY, 30 * DAY], repeat: null, max: 4, escalateAfter: 3, channels: ['email'] },
};

/** Tenant default quiet hours for external recipients (FPB-vendor-compliance-chase §5.2). */
export const DEFAULT_QUIET: QuietHours = { start: '20:00', end: '07:00' };

export interface OrgChaseSettings {
  timezone: string | null;
  chase_first_reminder_minutes: number | null;
  chase_followup_minutes: number | null;
  chase_escalation_threshold: number | null;
  chase_quiet_start: string | null;
  chase_quiet_end: string | null;
  chase_channel: string | null;
}

export interface PolicyRow {
  policy_key: PolicyKey;
  location_id: string | null;
  auto_create: boolean;
  cadence_anchor: 'created' | 'due' | null;
  cadence_offsets_minutes: number[] | null;
  repeat_every_minutes: number | null;
  max_sends: number | null;
  escalate_after: number | null;
  channels: string[] | null;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string | null;
}

/** Receipt-chase channel enum (Settings → Receipt chase) → engine channels. */
export function receiptChannels(chaseChannel: string | null | undefined): Channel[] {
  switch (chaseChannel) {
    case 'PUSH_ONLY':
      return ['push', 'in_app'];
    case 'SMS_ONLY':
      return ['sms', 'in_app'];
    case 'PUSH_SMS_EMAIL':
      return ['push', 'sms', 'email', 'in_app'];
    case 'PUSH_SMS':
    default:
      return ['push', 'sms', 'in_app'];
  }
}

function cleanChannels(v: string[] | null | undefined): Channel[] | null {
  if (!v || v.length === 0) return null;
  const c = v.filter(isChannel);
  return c.length ? Array.from(new Set(c)) : null;
}

export function receiptPolicy(org: OrgChaseSettings): ResolvedPolicy {
  const first = Math.max(0, Number(org.chase_first_reminder_minutes ?? 30));
  const follow = Math.max(15, Number(org.chase_followup_minutes ?? 120));
  const esc = org.chase_escalation_threshold != null ? Math.max(1, Number(org.chase_escalation_threshold)) : 3;
  return {
    key: 'receipt',
    label: 'Receipt chase',
    cadence: { anchor: 'created', offsetsMinutes: [first], repeatEveryMinutes: follow, maxSends: 10 },
    anchor: 'created',
    escalateAfter: esc,
    channels: receiptChannels(org.chase_channel),
    quiet: quietHoursOf(org.chase_quiet_start, org.chase_quiet_end),
    timezone: resolveTimeZone(org.timezone),
    autoCreate: false, // receipt requests are created by the card feed (Wave 2B), never by this engine
    source: 'receipt_settings',
  };
}

/** Pure merge: code default ← tenant 'default' row (quiet hours / tz) ← tenant row for the key. */
export function mergePolicy(key: Exclude<PolicyKey, 'default'>, org: OrgChaseSettings, rows: ReadonlyArray<PolicyRow>): ResolvedPolicy {
  const d = POLICY_DEFAULTS[key];
  const tenantDefault = rows.find((r) => r.policy_key === 'default' && r.location_id == null) ?? null;
  const row = rows.find((r) => r.policy_key === key && r.location_id == null) ?? null;
  const anchor = row?.cadence_anchor ?? d.anchor;
  const offsets = row?.cadence_offsets_minutes?.length ? [...row.cadence_offsets_minutes].sort((a, b) => a - b) : d.offsets;
  const repeat = row?.repeat_every_minutes ?? d.repeat;
  const quiet =
    quietHoursOf(row?.quiet_start, row?.quiet_end) ?? quietHoursOf(tenantDefault?.quiet_start, tenantDefault?.quiet_end) ?? DEFAULT_QUIET;
  return {
    key,
    label: d.label,
    cadence: { anchor, offsetsMinutes: offsets, repeatEveryMinutes: repeat, maxSends: row?.max_sends ?? d.max },
    anchor,
    escalateAfter: row?.escalate_after ?? d.escalateAfter,
    channels: cleanChannels(row?.channels) ?? d.channels,
    quiet,
    timezone: resolveTimeZone(row?.timezone, tenantDefault?.timezone, org.timezone),
    autoCreate: row?.auto_create ?? false,
    source: row ? 'tenant' : 'default',
  };
}

/** The policy key a request of `kind` uses (renewal = a due-anchored COI). */
export function policyKeyFor(kind: RequestKind, opts: { renewal?: boolean } = {}): Exclude<PolicyKey, 'default'> | 'receipt' {
  if (kind === 'receipt') return 'receipt';
  if (kind === 'coi' && opts.renewal) return 'coi_renewal';
  return kind;
}

export interface PolicyContext {
  org: OrgChaseSettings;
  rows: PolicyRow[];
}

/** Load the org's chase settings + tenant policy rows (service client, org pinned). */
export async function loadPolicyContext(db: SupabaseClient, orgId: string): Promise<PolicyContext> {
  const [{ data: org, error: orgErr }, { data: rows, error: rowErr }] = await Promise.all([
    db
      .schema('core')
      .from('organizations')
      .select('timezone, chase_first_reminder_minutes, chase_followup_minutes, chase_escalation_threshold, chase_quiet_start, chase_quiet_end, chase_channel')
      .eq('id', orgId)
      .maybeSingle(),
    db
      .schema('core')
      .from('request_policies')
      .select('policy_key, location_id, auto_create, cadence_anchor, cadence_offsets_minutes, repeat_every_minutes, max_sends, escalate_after, channels, quiet_start, quiet_end, timezone')
      .eq('org_id', orgId),
  ]);
  if (orgErr) throw new Error(`Could not read the organization's chase settings: ${orgErr.message}`);
  if (rowErr) throw new Error(`Could not read request policies: ${rowErr.message}`);
  const o = (org ?? {}) as Partial<OrgChaseSettings>;
  return {
    org: {
      timezone: o.timezone ?? null,
      chase_first_reminder_minutes: o.chase_first_reminder_minutes ?? null,
      chase_followup_minutes: o.chase_followup_minutes ?? null,
      chase_escalation_threshold: o.chase_escalation_threshold ?? null,
      chase_quiet_start: o.chase_quiet_start ?? null,
      chase_quiet_end: o.chase_quiet_end ?? null,
      chase_channel: o.chase_channel ?? null,
    },
    rows: ((rows ?? []) as PolicyRow[]).filter((r) => (POLICY_KEYS as readonly string[]).includes(r.policy_key)),
  };
}

export function resolvePolicy(ctx: PolicyContext, kind: RequestKind, opts: { renewal?: boolean } = {}): ResolvedPolicy {
  const key = policyKeyFor(kind, opts);
  return key === 'receipt' ? receiptPolicy(ctx.org) : mergePolicy(key, ctx.org, ctx.rows);
}

/** Every policy, in display order, for the settings card. */
export function allPolicies(ctx: PolicyContext): ResolvedPolicy[] {
  const keys: Array<Exclude<PolicyKey, 'default'>> = ['w9', 'coi', 'coi_renewal', 'client_question', 'document', 'approval_nudge', 'dunning'];
  return [...keys.map((k) => mergePolicy(k, ctx.org, ctx.rows)), receiptPolicy(ctx.org)];
}
