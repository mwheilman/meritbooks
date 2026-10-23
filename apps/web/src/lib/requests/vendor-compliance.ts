/**
 * End-to-end proof on the request engine: vendor W-9 / COI chase (FPB-request-engine-
 * notifications §4 "Vendor proof"; thin on purpose — the full requirement model and the
 * review loop are Wave 2A, FPB-vendor-compliance-chase).
 *
 *   W-9 MISSING / EXPIRED                    → one `w9` request   (day 0, 3, 7, then weekly)
 *   GL / WC COI MISSING / EXPIRED            → one `coi` request  (same)
 *   GL / WC COI VALID, expiring ≤ 30 days    → one `coi` request anchored on the expiry
 *                                               (T-30, T-15, T-0, then weekly)
 *
 * The email's button is the request's magic link, which lands on the EXISTING vendor
 * upload portal (/portal/vendor/[token], migration 142) — reused if the vendor has a live
 * link, else minted (90 days). The w9/coi resolver closes the request when the document
 * is on file or a portal upload lands. Automatic creation is OFF until the tenant turns
 * it on (request_policies.auto_create — owner decision D1); "New request" works anyway.
 *
 * Service role, org pinned on every statement (scheduler + routes after compliance:manage).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { generatePortalToken, type PortalDocKind } from '@/lib/portal/vendor/tokens';
import { loadPolicyContext, resolvePolicy, type PolicyContext } from './policy';
import { createRequest, RequestError, type CreateResult } from './service';
import { SYSTEM_ACTOR } from './types';

const COI_TYPES = ['GL_COI', 'WC_COI'] as const;
const RENEWAL_WINDOW_DAYS = 30;
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
  | { kind: 'w9'; docTypes: string[]; renewal: false; dueDate: null }
  | { kind: 'coi'; docTypes: string[]; renewal: boolean; dueDate: string | null };

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pure: what one vendor is missing / about to lose, from its compliance docs. */
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
      message: `We need a current Form W-9 for ${vendor.name} before we can keep paying invoices on time. Upload a PDF or a phone photo with the button below.`,
    };
  }
  if (need.renewal && need.dueDate) {
    return {
      title: `Your certificate of insurance expires ${need.dueDate}`,
      message: `The certificate we have on file for ${vendor.name} is about to expire. Please send the renewed certificate (or ask your insurance agent to) with the button below.`,
    };
  }
  return {
    title: 'Please send your certificate of insurance',
    message: `We need a current certificate of insurance for ${vendor.name}. Upload the PDF (or ask your insurance agent to send it) with the button below.`,
  };
}

/** Open (or return the live) w9/coi request for one vendor. */
export async function createVendorDocRequest(
  deps: { db: SupabaseClient; now: () => Date },
  ctx: PolicyContext,
  args: { orgId: string; vendor: VendorRef; need: VendorNeed; createdBy: string; ownerMembershipId?: string | null; source: 'manual' | 'scheduler' },
): Promise<CreateResult> {
  const now = deps.now();
  const portalKinds: PortalDocKind[] = args.need.kind === 'w9' ? ['W9'] : ['COI'];
  const portalTokenId = await ensureVendorPortalLink(deps.db, args.orgId, args.vendor.id, portalKinds, now);
  const { title, message } = copy(args.need, args.vendor);
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
      meta: { doc_types: args.need.docTypes, vendor_portal_token_id: portalTokenId, portal_docs: portalKinds },
      createdBy: args.createdBy,
    },
    ctx,
  );
}

export interface VendorSyncSummary {
  enabled: boolean;
  vendorsChecked: number;
  created: number;
  alreadyOpen: number;
  errors: string[];
}

/** Scheduler step: open requests for every vendor with a lapsed / expiring document (when auto-create is on). */
export async function syncVendorComplianceRequests(deps: { db: SupabaseClient; now: () => Date }, orgId: string, opts: { ctx?: PolicyContext } = {}): Promise<VendorSyncSummary> {
  const ctx = opts.ctx ?? (await loadPolicyContext(deps.db, orgId));
  const on = {
    w9: resolvePolicy(ctx, 'w9').autoCreate,
    coi: resolvePolicy(ctx, 'coi').autoCreate,
    renewal: resolvePolicy(ctx, 'coi', { renewal: true }).autoCreate,
  };
  const summary: VendorSyncSummary = { enabled: on.w9 || on.coi || on.renewal, vendorsChecked: 0, created: 0, alreadyOpen: 0, errors: [] };
  if (!summary.enabled) return summary;

  const { data: docs, error } = await deps.db
    .from('vendor_compliance_docs')
    .select('vendor_id, doc_type, status, expiration_date')
    .eq('org_id', orgId)
    .in('doc_type', ['W9', ...COI_TYPES]);
  if (error) throw new Error(`Could not read vendor compliance documents: ${error.message}`);
  const byVendor = new Map<string, DocRow[]>();
  for (const d of (docs ?? []) as DocRow[]) byVendor.set(d.vendor_id, [...(byVendor.get(d.vendor_id) ?? []), d]);
  if (byVendor.size === 0) return summary;

  const { data: vendors, error: vErr } = await deps.db
    .schema('core')
    .from('vendors')
    .select('id, name, display_name, email, is_active')
    .eq('org_id', orgId)
    .in('id', Array.from(byVendor.keys()));
  if (vErr) throw new Error(`Could not read vendors: ${vErr.message}`);

  // Cool-down: what a person cancelled, the vendor answered (e.g. uploaded and waiting for
  // review) or what expired unanswered is not re-opened by the nightly sync for 30 days.
  const { data: closedRows } = await deps.db
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

  const today = deps.now().toISOString().slice(0, 10);
  for (const v of (vendors ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null; is_active: boolean | null }>) {
    if (v.is_active === false) continue;
    summary.vendorsChecked++;
    const vendor: VendorRef = { id: v.id, name: v.display_name || v.name, email: v.email };
    for (const need of vendorNeeds(byVendor.get(v.id) ?? [], today)) {
      const allowed = need.kind === 'w9' ? on.w9 : need.renewal ? on.renewal : on.coi;
      if (!allowed) continue;
      if (cooling.has(`vc:${need.kind}:${vendor.id}`)) continue;
      try {
        const res = await createVendorDocRequest(deps, ctx, { orgId, vendor, need, createdBy: SYSTEM_ACTOR, source: 'scheduler' });
        if (res.created) summary.created++;
        else summary.alreadyOpen++;
      } catch (e) {
        summary.errors.push(`${vendor.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
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
