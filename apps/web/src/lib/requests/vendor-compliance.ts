/**
 * Vendor W-9 / COI chase on the request engine (FPB-request-engine-notifications §4
 * "Vendor proof"; closed loop FPB-vendor-compliance-chase §19).
 *
 * What a vendor owes comes from its REQUIREMENT SET (lib/vendor-compliance, migration
 * 180) — the strictest merge across every company that has billed it:
 *
 *   W-9 required and not on file                → one `w9` request (day 0, 3, 7, weekly)
 *   a COI rule missing / short / expired / unmet → one `coi` request naming what is wrong
 *   COI evidence expiring within the set's lead  → one `coi` request anchored on the expiry
 *                                                  (T-lead, T-lead/2, T-0, then weekly)
 *   anything waiting for review                  → nothing (the vendor already answered)
 *
 * With no requirement set the legacy rule applies unchanged: a tracked doc row that is
 * MISSING / EXPIRED (or a GL / WC COI expiring within 30 days).
 *
 * The email's button is the request's magic link, which lands on the vendor portal
 * (/portal/vendor/[token], migration 142) — reused if the vendor has a live link, else
 * minted (90 days). Automatic creation is OFF until the tenant turns it on for the firm
 * or for a company (request_policies.auto_create, org row or per-company rows — owner
 * decision D1); "Request now" works regardless. `planVendorChase` is the shared plan the
 * sync executes and the settings preview shows ("who would be emailed").
 *
 * Service role, org pinned on every statement (scheduler + routes after compliance:manage).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { generatePortalToken, type PortalDocKind } from '@/lib/portal/vendor/tokens';
import { evaluateRequirements, type RequirementSet, type RuleResult } from '@/lib/vendor-compliance/requirements';
import { governingSet, loadProfiles, loadRequirementSets, loadVendorCompanies, loadVendorFacts, loadVendors } from '@/lib/vendor-compliance/store';
import { loadPolicyContext, resolvePolicy, type PolicyContext } from './policy';
import { createRequest, RequestError, type CreateResult } from './service';
import { LIVE_STATUSES, SYSTEM_ACTOR } from './types';

const COI_TYPES = ['GL_COI', 'WC_COI'] as const;
const RENEWAL_WINDOW_DAYS = 30;
const DAY_MIN = 1440;
/** A request a person (or the vendor) closed is not re-opened by the sync for this long. */
export const REOPEN_COOLDOWN_DAYS = 30;
const PORTAL_LINK_DAYS = 90;

export interface VendorRef {
  id: string;
  name: string;
  email: string | null;
}

interface DocRow {
  vendor_id: string;
  doc_type: string;
  status: string;
  expiration_date: string | null;
}

export type VendorNeed =
  | { kind: 'w9'; docTypes: string[]; renewal: false; dueDate: null; reason?: string }
  | { kind: 'coi'; docTypes: string[]; renewal: boolean; dueDate: string | null; reason?: string; leadDays?: number };

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pure (legacy, no requirement set): what one vendor is missing / about to lose, from its doc rows. */
export function vendorNeeds(docs: ReadonlyArray<DocRow>, today: string): VendorNeed[] {
  const out: VendorNeed[] = [];
  const lapsed = (d: DocRow) => d.status === 'MISSING' || d.status === 'EXPIRED' || (d.status === 'VALID' && !!d.expiration_date && d.expiration_date < today);
  const w9 = docs.filter((d) => d.doc_type === 'W9');
  if (w9.length && w9.every(lapsed)) out.push({ kind: 'w9', docTypes: ['W9'], renewal: false, dueDate: null });

  const cois = docs.filter((d) => (COI_TYPES as readonly string[]).includes(d.doc_type));
  const missing = cois.filter(lapsed).map((d) => d.doc_type);
  if (missing.length) {
    out.push({ kind: 'coi', docTypes: Array.from(new Set(missing)), renewal: false, dueDate: null });
  } else {
    const horizon = addDays(today, RENEWAL_WINDOW_DAYS);
    const expiring = cois.filter((d) => d.status === 'VALID' && d.expiration_date && d.expiration_date >= today && d.expiration_date <= horizon);
    if (expiring.length) {
      const due = expiring.map((d) => d.expiration_date as string).sort()[0];
      out.push({ kind: 'coi', docTypes: Array.from(new Set(expiring.map((d) => d.doc_type))), renewal: true, dueDate: due });
    }
  }
  return out;
}

const COI_RULES = new Set(['COI_GL_OCCURRENCE', 'COI_GL_AGGREGATE', 'COI_AUTO', 'COI_WC', 'COI_UMBRELLA', 'END_ADDITIONAL_INSURED', 'END_WAIVER_SUBROGATION', 'CERT_HOLDER']);
const ASK = new Set(['missing', 'short', 'expired', 'not_met']);

/** Pure: needs from a requirement-set evaluation. Pending review → nothing; grace → renewal. */
export function needsFromRules(rules: ReadonlyArray<RuleResult>, set: Pick<RequirementSet, 'expiryLeadDays'>): VendorNeed[] {
  const out: VendorNeed[] = [];
  const w9 = rules.find((r) => r.rule === 'W9');
  if (w9 && ASK.has(w9.outcome)) out.push({ kind: 'w9', docTypes: ['W9'], renewal: false, dueDate: null, reason: w9.reason });
  const coi = rules.filter((r) => COI_RULES.has(r.rule));
  const failing = coi.filter((r) => ASK.has(r.outcome));
  if (failing.length) {
    out.push({ kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null, reason: failing.map((r) => `${r.label}: ${r.reason}`).join(' ') });
  } else if (!coi.some((r) => r.outcome === 'pending')) {
    const soon = coi.filter((r) => (r.outcome === 'expiring' || r.outcome === 'grace') && r.expiresOn).map((r) => r.expiresOn as string).sort();
    if (soon.length) out.push({ kind: 'coi', docTypes: ['GL_COI'], renewal: true, dueDate: soon[0], leadDays: set.expiryLeadDays });
  }
  return out;
}

/** A live vendor-portal link for these doc kinds (reused when one covers them), else a new one. */
export async function ensureVendorPortalLink(db: SupabaseClient, orgId: string, vendorId: string, kinds: PortalDocKind[], now: Date): Promise<string> {
  const writer = serviceWriter(db);
  const minExpiry = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  const { data: existing } = await writer
    .from('vendor_portal_tokens')
    .select('id, requested_docs, expires_at, status')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: false })
    .limit(10);
  for (const t of (existing ?? []) as Array<{ id: string; requested_docs: string[] | null; expires_at: string | null }>) {
    const covers = kinds.every((k) => (t.requested_docs ?? []).includes(k));
    if (covers && (!t.expires_at || t.expires_at > minExpiry)) return t.id;
  }
  const { data, error } = await writer
    .from('vendor_portal_tokens')
    .insert({
      org_id: orgId,
      vendor_id: vendorId,
      token: generatePortalToken(),
      label: 'Document request link',
      status: 'ACTIVE',
      requested_docs: kinds,
      expires_at: new Date(now.getTime() + PORTAL_LINK_DAYS * 86_400_000).toISOString(),
      created_by: SYSTEM_ACTOR,
    })
    .select('id')
    .single();
  if (error || !data) throw new RequestError(`Could not create the vendor upload link: ${error?.message ?? 'no row'}`, 500);
  return (data as { id: string }).id;
}

function copy(need: VendorNeed, vendor: VendorRef): { title: string; message: string } {
  if (need.kind === 'w9') {
    return {
      title: 'Please send your W-9',
      message: `We need a current Form W-9 for ${vendor.name} before we can keep paying invoices on time. You can fill it in and e-sign it online in about three minutes, or upload a signed PDF or phone photo, with the button below.`,
    };
  }
  if (need.renewal && need.dueDate) {
    return {
      title: `Your certificate of insurance expires ${need.dueDate}`,
      message: `The certificate we have on file for ${vendor.name} expires ${need.dueDate}. Please send the renewed certificate (or forward this to your insurance agent) with the button below so payments are not held.`,
    };
  }
  return {
    title: 'Please send your certificate of insurance',
    message: `We need a current certificate of insurance for ${vendor.name}.${need.reason ? `\n\nWhat we still need: ${need.reason}` : ''}\n\nUpload the PDF (or forward this to your insurance agent) with the button below.`,
  };
}

/** Open (or return the live) w9/coi request for one vendor. */
export async function createVendorDocRequest(
  deps: { db: SupabaseClient; now: () => Date },
  ctx: PolicyContext,
  args: {
    orgId: string;
    vendor: VendorRef;
    need: VendorNeed;
    createdBy: string;
    ownerMembershipId?: string | null;
    source: 'manual' | 'scheduler';
    /** Replace the standard wording (a correction request quoting a rejection reason). */
    copy?: { title: string; message: string };
  },
): Promise<CreateResult> {
  const now = deps.now();
  const portalKinds: PortalDocKind[] = args.need.kind === 'w9' ? ['W9'] : ['COI'];
  const portalTokenId = await ensureVendorPortalLink(deps.db, args.orgId, args.vendor.id, portalKinds, now);
  const { title, message } = args.copy ?? copy(args.need, args.vendor);
  const lead = args.need.kind === 'coi' && args.need.renewal ? args.need.leadDays : undefined;
  const cadence =
    lead !== undefined && lead !== 30 && lead > 0
      ? { offsetsMinutes: Array.from(new Set([-lead * DAY_MIN, -Math.round(lead / 2) * DAY_MIN, 0])) }
      : undefined;
  return createRequest(
    deps,
    {
      orgId: args.orgId,
      kind: args.need.kind,
      renewal: args.need.renewal,
      dueDate: args.need.dueDate,
      subjectType: 'vendor',
      subjectId: args.vendor.id,
      dedupeKey: `vc:${args.need.kind}:${args.vendor.id}`,
      title,
      message,
      deepLink: `/vendor-compliance?vendor=${args.vendor.id}`,
      recipient: { type: 'vendor_contact', vendorId: args.vendor.id, name: args.vendor.name, email: args.vendor.email },
      ownerMembershipId: args.ownerMembershipId ?? null,
      source: args.source,
      cadence,
      meta: { doc_types: args.need.docTypes, vendor_portal_token_id: portalTokenId, portal_docs: portalKinds, reason: args.need.reason ?? null },
      createdBy: args.createdBy,
    },
    ctx,
  );
}

// ── The plan (shared by the sync and the "who would be emailed" preview) ─────

export type PlanStatus = 'would_send' | 'no_email' | 'already_open' | 'cooling' | 'switch_off';

export interface PlanItem {
  vendor: VendorRef;
  need: VendorNeed;
  companies: string[];
  status: PlanStatus;
  why: string;
}

export interface ChaseSwitches {
  /** Firm-wide switch per policy. */
  org: { w9: boolean; coi: boolean; renewal: boolean };
  /** Per-company switches (location id → policy → on). */
  byCompany: Map<string, { w9?: boolean; coi?: boolean; renewal?: boolean }>;
}

export function chaseSwitches(ctx: PolicyContext): ChaseSwitches {
  const byCompany = new Map<string, { w9?: boolean; coi?: boolean; renewal?: boolean }>();
  for (const r of ctx.rows) {
    if (!r.location_id) continue;
    const k = r.policy_key === 'w9' ? 'w9' : r.policy_key === 'coi' ? 'coi' : r.policy_key === 'coi_renewal' ? 'renewal' : null;
    if (!k) continue;
    byCompany.set(r.location_id, { ...(byCompany.get(r.location_id) ?? {}), [k]: !!r.auto_create });
  }
  return {
    org: {
      w9: resolvePolicy(ctx, 'w9').autoCreate,
      coi: resolvePolicy(ctx, 'coi').autoCreate,
      renewal: resolvePolicy(ctx, 'coi', { renewal: true }).autoCreate,
    },
    byCompany,
  };
}

/** Pure: is automatic chase on for this need, firm-wide or for any company the vendor works for? */
export function autoOn(sw: ChaseSwitches, need: VendorNeed, companies: ReadonlyArray<string>, onlyCompany?: string | null): boolean {
  const key: 'w9' | 'coi' | 'renewal' = need.kind === 'w9' ? 'w9' : need.renewal ? 'renewal' : 'coi';
  if (onlyCompany) return sw.byCompany.get(onlyCompany)?.[key] ?? sw.org[key];
  if (sw.org[key]) return true;
  return companies.some((c) => sw.byCompany.get(c)?.[key] === true);
}

export interface ChasePlan {
  anyOn: boolean;
  items: PlanItem[];
  vendorsChecked: number;
  requirementSets: number;
}

/**
 * Everything the sync would do right now, and why not for the rest. `forceOn` previews as
 * if the switch were on (the settings card shows who WOULD be emailed before turning it on).
 */
export async function planVendorChase(
  deps: { db: SupabaseClient; now: () => Date },
  orgId: string,
  opts: { ctx?: PolicyContext; locationId?: string | null; forceOn?: boolean } = {},
): Promise<ChasePlan> {
  const db = deps.db;
  const ctx = opts.ctx ?? (await loadPolicyContext(db, orgId));
  const sw = chaseSwitches(ctx);
  const anyOn = sw.org.w9 || sw.org.coi || sw.org.renewal || Array.from(sw.byCompany.values()).some((v) => v.w9 || v.coi || v.renewal);
  const today = deps.now().toISOString().slice(0, 10);

  const sets = await loadRequirementSets(db, orgId);
  const { data: docRows, error } = await db
    .from('vendor_compliance_docs')
    .select('vendor_id, doc_type, status, expiration_date')
    .eq('org_id', orgId)
    .in('doc_type', ['W9', ...COI_TYPES]);
  if (error) throw new Error(`Could not read vendor compliance documents: ${error.message}`);
  const docsBy = new Map<string, DocRow[]>();
  for (const d of (docRows ?? []) as DocRow[]) docsBy.set(d.vendor_id, [...(docsBy.get(d.vendor_id) ?? []), d]);

  // Universe: vendors with tracked docs, plus every active vendor once a requirement set exists.
  const vendors = sets.length ? await loadVendors(db, orgId) : docsBy.size ? await loadVendors(db, orgId, Array.from(docsBy.keys())) : [];
  const active = vendors.filter((v) => v.isActive);
  const ids = active.map((v) => v.id);
  const [profiles, companies, factsBundle] = sets.length
    ? await Promise.all([loadProfiles(db, orgId), loadVendorCompanies(db, orgId), loadVendorFacts(db, orgId, ids, today)])
    : [new Map(), new Map<string, string[]>(), { facts: new Map(), docs: new Map() }];
  if (sets.length === 0 && docsBy.size === 0) return { anyOn, items: [], vendorsChecked: 0, requirementSets: 0 };
  const companiesOf = (id: string) => companies.get(id) ?? [];

  const { data: liveRows } = await db.schema('core').from('requests').select('dedupe_key').eq('org_id', orgId).in('status', [...LIVE_STATUSES]).like('dedupe_key', 'vc:%').limit(5000);
  const live = new Set(((liveRows ?? []) as Array<{ dedupe_key: string | null }>).map((r) => r.dedupe_key).filter((k): k is string => !!k));
  const { data: closedRows } = await db
    .schema('core')
    .from('requests')
    .select('dedupe_key, fulfilled_at, cancelled_at, updated_at')
    .eq('org_id', orgId)
    .in('status', ['fulfilled', 'cancelled', 'expired'])
    .like('dedupe_key', 'vc:%')
    .limit(5000);
  const cutoff = deps.now().getTime() - REOPEN_COOLDOWN_DAYS * 86_400_000;
  const cooling = new Set<string>();
  for (const c of (closedRows ?? []) as Array<{ dedupe_key: string | null; fulfilled_at: string | null; cancelled_at: string | null; updated_at: string | null }>) {
    const at = Math.max(...[c.fulfilled_at, c.cancelled_at, c.updated_at].map((x) => (x ? new Date(x).getTime() : 0)));
    if (c.dedupe_key && at > cutoff) cooling.add(c.dedupe_key);
  }

  const items: PlanItem[] = [];
  let checked = 0;
  for (const v of active) {
    const vc = companiesOf(v.id);
    if (opts.locationId && !vc.includes(opts.locationId)) continue;
    checked++;
    let needs: VendorNeed[];
    const p = profiles.get(v.id) as { vendorType: RequirementSet['vendorType']; workType: string | null } | undefined;
    const set = sets.length
      ? governingSet(sets, { vendorType: p?.vendorType ?? null, workType: p?.workType ?? null, is1099Eligible: v.is1099Eligible }, opts.locationId ? { locationId: opts.locationId } : { companies: vc })
      : null;
    if (set) {
      const facts = factsBundle.facts.get(v.id);
      needs = facts ? needsFromRules(evaluateRequirements(set, facts, today), set) : [];
    } else {
      needs = vendorNeeds(docsBy.get(v.id) ?? [], today);
    }
    const ref: VendorRef = { id: v.id, name: v.name, email: v.email };
    for (const need of needs) {
      const key = `vc:${need.kind}:${v.id}`;
      const what = need.kind === 'w9' ? 'W-9' : need.renewal ? `certificate renewal (expires ${need.dueDate})` : 'certificate of insurance';
      let status: PlanStatus;
      let why: string;
      if (live.has(key)) {
        status = 'already_open';
        why = `A ${what} request is already being chased.`;
      } else if (cooling.has(key)) {
        status = 'cooling';
        why = `A ${what} request closed in the last ${REOPEN_COOLDOWN_DAYS} days (answered or cancelled); not asking again yet.`;
      } else if (!opts.forceOn && !autoOn(sw, need, vc, opts.locationId)) {
        status = 'switch_off';
        why = `Automatic chase is off — use “Request now”.`;
      } else if (!v.email) {
        status = 'no_email';
        why = `Needs a ${what}, but the vendor has no email address — add one so the request can go out.`;
      } else {
        status = 'would_send';
        why = `Email ${v.email}: ${what}${need.reason ? ` — ${need.reason}` : ''}`;
      }
      items.push({ vendor: ref, need, companies: vc, status, why });
    }
  }
  return { anyOn, items, vendorsChecked: checked, requirementSets: sets.length };
}

export interface VendorSyncSummary {
  enabled: boolean;
  vendorsChecked: number;
  created: number;
  alreadyOpen: number;
  errors: string[];
}

/** Scheduler step: open requests for every vendor the plan says to ask (when the switch is on). */
export async function syncVendorComplianceRequests(deps: { db: SupabaseClient; now: () => Date }, orgId: string, opts: { ctx?: PolicyContext } = {}): Promise<VendorSyncSummary> {
  const ctx = opts.ctx ?? (await loadPolicyContext(deps.db, orgId));
  const sw = chaseSwitches(ctx);
  const enabled = sw.org.w9 || sw.org.coi || sw.org.renewal || Array.from(sw.byCompany.values()).some((v) => v.w9 || v.coi || v.renewal);
  const summary: VendorSyncSummary = { enabled, vendorsChecked: 0, created: 0, alreadyOpen: 0, errors: [] };
  if (!enabled) return summary;
  const plan = await planVendorChase(deps, orgId, { ctx });
  summary.vendorsChecked = plan.vendorsChecked;
  for (const item of plan.items) {
    if (item.status === 'already_open') {
      summary.alreadyOpen++;
      continue;
    }
    if (item.status !== 'would_send' && item.status !== 'no_email') continue;
    try {
      const res = await createVendorDocRequest(deps, ctx, { orgId, vendor: item.vendor, need: item.need, createdBy: SYSTEM_ACTOR, source: 'scheduler' });
      if (res.created) summary.created++;
      else summary.alreadyOpen++;
    } catch (e) {
      summary.errors.push(`${item.vendor.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

/** The vendor-portal path a w9/coi request's magic link forwards to (null when none). */
export async function vendorPortalPathFor(db: SupabaseClient, orgId: string, meta: Record<string, unknown>): Promise<string | null> {
  const id = typeof meta?.vendor_portal_token_id === 'string' ? meta.vendor_portal_token_id : null;
  if (!id) return null;
  const { data } = await db.from('vendor_portal_tokens').select('token, status, expires_at').eq('id', id).eq('org_id', orgId).maybeSingle();
  const t = data as { token: string; status: string; expires_at: string | null } | null;
  if (!t || t.status !== 'ACTIVE' || (t.expires_at && new Date(t.expires_at).getTime() <= Date.now())) return null;
  return `/portal/vendor/${encodeURIComponent(t.token)}`;
}
