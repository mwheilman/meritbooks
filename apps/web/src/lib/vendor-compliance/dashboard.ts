/**
 * Vendor compliance dashboard + per-vendor timeline (FPB §19.2). Read-only; runs on the
 * caller's RLS client (members SELECT their org — 180 tables, docs, bills, requests).
 *
 *   buildDashboard   every vendor in scope with its requirement strip, bucket flags
 *                    (compliant · expiring ≤ 30 days · missing · on hold · waiting for
 *                    review · bank change), open A/P exposure, and counts by company
 *   vendorTimeline   compliance events + request events for one vendor, newest first
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DOC_LABEL, overrideActive, type OverrideRow } from '@/lib/services/vendor-compliance';
import {
  BLOCKING,
  addDays,
  evaluateRequirements,
  summarise,
  type RequirementSet,
  type RuleOutcome,
  type VendorType,
} from './requirements';
import { fetchAll, governingSet, loadProfiles, loadRequirementSets, loadVendorCompanies, loadVendorFacts, loadVendors } from './store';

type DB = SupabaseClient;

export interface StripCell {
  id: string;
  label: string;
  outcome: RuleOutcome;
  reason: string;
  expiresOn: string | null;
}

export interface DashboardRow {
  vendorId: string;
  vendorName: string;
  email: string | null;
  vendorType: VendorType | null;
  workType: string | null;
  is1099Eligible: boolean | null;
  companies: Array<{ id: string; name: string }>;
  requirementSet: { id: string; name: string; blockPayment: boolean } | null;
  rules: StripCell[];
  compliant: boolean;
  expiring: boolean;
  missing: boolean;
  onHold: boolean;
  pendingReview: number;
  bankChangePending: boolean;
  override: { id: string; type: string; reason: string; endDate: string | null } | null;
  nextExpiry: string | null;
  openBillsCents: number;
  liveRequest: { id: string; kind: string; status: string; nextSendAt: string | null; sendsCount: number } | null;
  /** One line: the worst thing, in words. */
  headline: string;
}

export interface CompanyCounts {
  locationId: string;
  name: string;
  total: number;
  compliant: number;
  expiring: number;
  missing: number;
  onHold: number;
}

export interface DashboardSummary {
  total: number;
  compliant: number;
  expiring: number;
  missing: number;
  onHold: number;
  pendingReview: number;
  bankChanges: number;
  blockedBalanceCents: number;
  requirementSets: number;
}

export interface Dashboard {
  rows: DashboardRow[];
  summary: DashboardSummary;
  byCompany: CompanyCounts[];
  asOf: string;
}

const OPEN_BILL = ['PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'ON_HOLD'];

function legacyCells(docs: ReadonlyArray<{ doc_type: string; status: string; expiration_date: string | null }>, today: string): StripCell[] {
  return docs.map((d) => {
    const label = DOC_LABEL[d.doc_type] ?? d.doc_type;
    let outcome: RuleOutcome = 'met';
    let reason = `${label} on file.`;
    if (d.status === 'MISSING') [outcome, reason] = ['missing', `No ${label} on file.`];
    else if (d.status === 'PENDING') [outcome, reason] = ['pending', `${label} waiting for review.`];
    else if (d.status === 'EXPIRED' || (d.expiration_date && d.expiration_date < today)) [outcome, reason] = ['expired', `${label} expired ${d.expiration_date ?? ''}.`.trim()];
    else if (d.expiration_date && d.expiration_date <= addDays(today, 30)) [outcome, reason] = ['expiring', `${label} expires ${d.expiration_date}.`];
    return { id: d.doc_type, label, outcome, reason, expiresOn: d.expiration_date };
  });
}

function headlineOf(r: Pick<DashboardRow, 'rules' | 'onHold' | 'bankChangePending' | 'pendingReview' | 'nextExpiry' | 'override'>): string {
  if (r.bankChangePending) return 'Bank details changed — call-back needed before paying.';
  const bad = r.rules.find((c) => BLOCKING.has(c.outcome) && c.outcome !== 'pending');
  if (bad) return `${r.onHold ? 'On hold: ' : ''}${bad.reason}`;
  if (r.pendingReview > 0) return 'A document is waiting for review.';
  const exp = r.rules.find((c) => c.outcome === 'expiring' || c.outcome === 'grace');
  if (exp) return exp.reason;
  if (r.override) return `Override in place: ${r.override.reason}`;
  if (r.rules.length === 0) return 'No requirements apply.';
  return r.nextExpiry ? `Compliant; next expiry ${r.nextExpiry}.` : 'Compliant.';
}

export async function buildDashboard(db: DB, orgId: string, opts: { locationId?: string | null; now?: Date } = {}): Promise<Dashboard> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = addDays(today, 30);

  const sets = await loadRequirementSets(db, orgId);
  const [docRows, pendingSubs, bankRows, locRows] = await Promise.all([
    fetchAll<{ vendor_id: string; doc_type: string; status: string; expiration_date: string | null }>((a, b) =>
      db.from('vendor_compliance_docs').select('vendor_id, doc_type, status, expiration_date').eq('org_id', orgId).range(a, b),
    ),
    fetchAll<{ vendor_id: string }>((a, b) => db.from('vendor_document_submissions').select('vendor_id').eq('org_id', orgId).in('status', ['received', 'ai_checked']).range(a, b)),
    fetchAll<{ vendor_id: string }>((a, b) => db.from('vendor_bank_change_verifications').select('vendor_id').eq('org_id', orgId).eq('status', 'pending').range(a, b)),
    fetchAll<{ id: string; name: string }>((a, b) => db.schema('core').from('locations').select('id, name').eq('org_id', orgId).range(a, b)),
  ]);
  const locName = new Map(locRows.map((l) => [l.id, l.name]));
  const docsBy = new Map<string, typeof docRows>();
  for (const d of docRows) docsBy.set(d.vendor_id, [...(docsBy.get(d.vendor_id) ?? []), d]);
  const pendingBy = new Map<string, number>();
  for (const s of pendingSubs) pendingBy.set(s.vendor_id, (pendingBy.get(s.vendor_id) ?? 0) + 1);
  const bankBy = new Set(bankRows.map((b) => b.vendor_id));

  const tracked = new Set<string>([...docsBy.keys(), ...pendingBy.keys(), ...bankBy]);
  const vendorsAll = sets.length ? await loadVendors(db, orgId) : tracked.size ? await loadVendors(db, orgId, Array.from(tracked)) : [];
  const vendors = vendorsAll.filter((v) => v.isActive || tracked.has(v.id));
  const ids = vendors.map((v) => v.id);
  const [profiles, companies, factsBundle] = await Promise.all([
    loadProfiles(db, orgId),
    loadVendorCompanies(db, orgId),
    sets.length ? loadVendorFacts(db, orgId, ids, today) : Promise.resolve({ facts: new Map(), docs: new Map() }),
  ]);

  const [overrideRows, billRows, reqRows] = await Promise.all([
    fetchAll<OverrideRow & { vendor_id: string }>((a, b) =>
      db.from('vendor_payment_holds').select('id, vendor_id, hold_type, reason, start_date, end_date, consumed_at, released_at, created_at').eq('org_id', orgId).range(a, b),
    ),
    fetchAll<{ vendor_id: string; location_id: string | null; total_cents: number | string | null; amount_paid_cents: number | string | null }>((a, b) =>
      db.from('bills').select('vendor_id, location_id, total_cents, amount_paid_cents').eq('org_id', orgId).in('status', OPEN_BILL).range(a, b),
    ),
    fetchAll<{ id: string; kind: string; status: string; next_send_at: string | null; sends_count: number; recipient_vendor_id: string | null }>((a, b) =>
      db.schema('core').from('requests').select('id, kind, status, next_send_at, sends_count, recipient_vendor_id').eq('org_id', orgId).in('kind', ['w9', 'coi']).in('status', ['open', 'sent', 'snoozed']).range(a, b),
    ),
  ]);
  const overrideBy = new Map<string, OverrideRow>();
  for (const o of overrideRows) if (overrideActive(o, now) && !overrideBy.has(o.vendor_id)) overrideBy.set(o.vendor_id, o);
  const openBy = new Map<string, number>();
  const openByCo = new Map<string, number>();
  for (const b of billRows) {
    const bal = Math.max(0, Number(b.total_cents ?? 0) - Number(b.amount_paid_cents ?? 0));
    openBy.set(b.vendor_id, (openBy.get(b.vendor_id) ?? 0) + bal);
    if (b.location_id) openByCo.set(`${b.vendor_id}:${b.location_id}`, (openByCo.get(`${b.vendor_id}:${b.location_id}`) ?? 0) + bal);
  }
  const reqBy = new Map<string, (typeof reqRows)[number]>();
  for (const r of reqRows) if (r.recipient_vendor_id && !reqBy.has(r.recipient_vendor_id)) reqBy.set(r.recipient_vendor_id, r);

  const evaluate = (vendorId: string, set: RequirementSet | null) => {
    if (set) {
      const facts = factsBundle.facts.get(vendorId);
      const results = facts ? evaluateRequirements(set, facts, today) : [];
      const sum = summarise(set, results);
      return { cells: results.map((r) => ({ id: r.rule, label: r.label, outcome: r.outcome, reason: r.reason, expiresOn: r.expiresOn })), blocks: sum.holds, nextExpiry: sum.nextExpiry };
    }
    const cells = legacyCells(docsBy.get(vendorId) ?? [], today);
    const blocks = cells.some((c) => c.outcome === 'missing' || c.outcome === 'expired');
    const next = cells.filter((c) => c.expiresOn && c.outcome !== 'expired').map((c) => c.expiresOn as string).sort()[0] ?? null;
    return { cells, blocks, nextExpiry: next };
  };

  const rows: DashboardRow[] = [];
  const byCompany = new Map<string, CompanyCounts>();
  for (const v of vendors) {
    const vc = companies.get(v.id) ?? [];
    if (opts.locationId && !vc.includes(opts.locationId)) continue;
    const p = profiles.get(v.id);
    const klass = { vendorType: p?.vendorType ?? null, workType: p?.workType ?? null, is1099Eligible: v.is1099Eligible };
    const set = sets.length ? governingSet(sets, klass, opts.locationId ? { locationId: opts.locationId } : { companies: vc }) : null;
    if (sets.length && !set && !tracked.has(v.id)) continue; // nothing applies, nothing tracked
    const ev = evaluate(v.id, set);
    const ov = overrideBy.get(v.id) ?? null;
    const bank = bankBy.has(v.id);
    const pending = pendingBy.get(v.id) ?? 0;
    const missing = ev.cells.some((c) => c.outcome === 'missing' || c.outcome === 'short' || c.outcome === 'expired' || c.outcome === 'not_met');
    const expiring = ev.cells.some((c) => c.outcome === 'expiring' || c.outcome === 'grace') || (!!ev.nextExpiry && ev.nextExpiry <= horizon);
    const onHold = bank || (ev.blocks && !ov);
    const lr = reqBy.get(v.id);
    const row: DashboardRow = {
      vendorId: v.id,
      vendorName: v.name,
      email: v.email,
      vendorType: p?.vendorType ?? null,
      workType: p?.workType ?? null,
      is1099Eligible: v.is1099Eligible,
      companies: vc.map((id) => ({ id, name: locName.get(id) ?? 'Company' })),
      requirementSet: set ? { id: set.id, name: set.name, blockPayment: set.blockPayment } : null,
      rules: ev.cells,
      compliant: !ev.cells.some((c) => BLOCKING.has(c.outcome)) && !bank,
      expiring,
      missing,
      onHold,
      pendingReview: pending,
      bankChangePending: bank,
      override: ov ? { id: ov.id, type: ov.hold_type, reason: ov.reason, endDate: ov.end_date } : null,
      nextExpiry: ev.nextExpiry,
      openBillsCents: opts.locationId ? openByCo.get(`${v.id}:${opts.locationId}`) ?? 0 : openBy.get(v.id) ?? 0,
      liveRequest: lr ? { id: lr.id, kind: lr.kind, status: lr.status, nextSendAt: lr.next_send_at, sendsCount: Number(lr.sends_count ?? 0) } : null,
      headline: '',
    };
    row.headline = headlineOf(row);
    rows.push(row);

    // Per company: that company's own set governs.
    for (const co of opts.locationId ? [opts.locationId] : vc) {
      const cset = sets.length ? governingSet(sets, klass, { locationId: co }) : null;
      const cev = cset === set ? ev : evaluate(v.id, cset);
      const c = byCompany.get(co) ?? { locationId: co, name: locName.get(co) ?? 'Company', total: 0, compliant: 0, expiring: 0, missing: 0, onHold: 0 };
      c.total++;
      if (!cev.cells.some((x) => BLOCKING.has(x.outcome)) && !bank) c.compliant++;
      if (cev.cells.some((x) => x.outcome === 'expiring' || x.outcome === 'grace')) c.expiring++;
      if (cev.cells.some((x) => x.outcome === 'missing' || x.outcome === 'short' || x.outcome === 'expired' || x.outcome === 'not_met')) c.missing++;
      if (bank || (cev.blocks && !ov)) c.onHold++;
      byCompany.set(co, c);
    }
  }

  const rank = (r: DashboardRow) => (r.bankChangePending ? 0 : r.onHold ? 1 : r.missing ? 2 : r.pendingReview ? 3 : r.expiring ? 4 : 5);
  rows.sort((a, b) => rank(a) - rank(b) || b.openBillsCents - a.openBillsCents || a.vendorName.localeCompare(b.vendorName));

  const summary: DashboardSummary = {
    total: rows.length,
    compliant: rows.filter((r) => r.compliant).length,
    expiring: rows.filter((r) => r.expiring).length,
    missing: rows.filter((r) => r.missing).length,
    onHold: rows.filter((r) => r.onHold).length,
    pendingReview: rows.reduce((n, r) => n + r.pendingReview, 0),
    bankChanges: rows.filter((r) => r.bankChangePending).length,
    blockedBalanceCents: rows.filter((r) => r.onHold).reduce((n, r) => n + r.openBillsCents, 0),
    requirementSets: sets.length,
  };
  return { rows, summary, byCompany: Array.from(byCompany.values()).sort((a, b) => b.onHold - a.onHold || a.name.localeCompare(b.name)), asOf: now.toISOString() };
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineItem {
  at: string;
  source: 'compliance' | 'request';
  type: string;
  title: string;
  detail: string | null;
  actor: string | null;
}

const COMPLIANCE_TITLE: Record<string, string> = {
  PAYMENT_BLOCKED: 'Payment blocked',
  OVERRIDE_GRANTED: 'Override granted',
  OVERRIDE_CONSUMED: 'Override used',
  OVERRIDE_RELEASED: 'Override ended',
  DOC_EXPIRED: 'Document expired',
  CHASE_SCHEDULED: 'Chase scheduled',
  REQUEST_CREATED: 'Request created',
  UPLOAD_RECEIVED: 'Document received',
  W9_FORM_SUBMITTED: 'W-9 e-signed in the portal',
  AI_CHECKED: 'AI read the document',
  AI_UNAVAILABLE: 'AI could not read it',
  REQUIREMENT_FAILED: 'A requirement was not met',
  DOC_ACCEPTED: 'Document accepted',
  DOC_REJECTED: 'Document rejected',
  HOLD_APPLIED: 'Payment hold applied',
  HOLD_LIFTED: 'Payment hold lifted',
  BILL_HOLD_RELEASED: 'Bill released from hold',
  BANK_CHANGE_OPENED: 'Bank details changed',
  BANK_CHANGE_VERIFIED: 'Bank change verified by call-back',
  BANK_CHANGE_REJECTED: 'Bank change rejected',
  PROFILE_CHANGED: 'Vendor classification changed',
};

const REQUEST_TITLE: Record<string, string> = {
  created: 'Request created',
  sent: 'Reminder sent',
  delivered: 'Email delivered',
  opened: 'Email opened',
  clicked: 'Link opened',
  fulfilled: 'Request closed',
  bounced: 'Email bounced',
  complained: 'Marked as spam',
  unsubscribed: 'Unsubscribed',
  failed: 'Send failed',
  skipped: 'Send skipped',
  escalated: 'Escalated to a person',
  snoozed: 'Snoozed',
  cancelled: 'Request cancelled',
  reopened: 'Request reopened',
  expired: 'Request ran out of reminders',
  deferred: 'Held for quiet hours',
  updated: 'Request updated',
  replied: 'Vendor replied',
};

export async function vendorTimeline(db: DB, orgId: string, vendorId: string, limit = 200): Promise<TimelineItem[]> {
  const [{ data: ce }, { data: reqs }] = await Promise.all([
    db.from('vendor_compliance_events').select('event_type, detail, created_by_user, created_at').eq('org_id', orgId).eq('vendor_id', vendorId).order('created_at', { ascending: false }).limit(limit),
    db.schema('core').from('requests').select('id, kind, title').eq('org_id', orgId).eq('recipient_vendor_id', vendorId).limit(200),
  ]);
  const items: TimelineItem[] = ((ce ?? []) as Array<{ event_type: string; detail: string | null; created_by_user: string | null; created_at: string }>).map((e) => ({
    at: e.created_at,
    source: 'compliance',
    type: e.event_type,
    title: COMPLIANCE_TITLE[e.event_type] ?? e.event_type,
    detail: e.detail,
    actor: e.created_by_user,
  }));
  const reqList = (reqs ?? []) as Array<{ id: string; kind: string; title: string }>;
  if (reqList.length) {
    const byId = new Map(reqList.map((r) => [r.id, r]));
    const { data: re } = await db
      .schema('core')
      .from('request_events')
      .select('request_id, event_type, channel, detail, actor, occurred_at')
      .eq('org_id', orgId)
      .in('request_id', reqList.map((r) => r.id))
      .order('occurred_at', { ascending: false })
      .limit(limit);
    for (const e of (re ?? []) as Array<{ request_id: string; event_type: string; channel: string | null; detail: string | null; actor: string | null; occurred_at: string }>) {
      const r = byId.get(e.request_id);
      items.push({
        at: e.occurred_at,
        source: 'request',
        type: e.event_type,
        title: `${REQUEST_TITLE[e.event_type] ?? e.event_type}${r ? ` · ${r.kind === 'w9' ? 'W-9' : 'COI'}` : ''}${e.channel && e.event_type === 'sent' ? ` (${e.channel})` : ''}`,
        detail: e.detail,
        actor: e.actor,
      });
    }
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
