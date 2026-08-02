/**
 * ACTION INBOX — "Needs you" collector.
 *
 * ONE read-only, ranked aggregate of everything that actually needs a human RIGHT
 * NOW, folded from the fragmented "act on it" sources across the platform into a
 * single common shape and ranked by urgency. It creates NO new tables and writes
 * nothing — it stitches already-existing source tables (money-movement approvals,
 * bills on hold, submitted expense reports, AI proposals, overdue obligations,
 * unposted manual journal-entry drafts) and ranks them.
 *
 * Two clean layers (mirrors lib/obligations/collect.ts):
 *   1. PURE (deterministic, unit-tested): the common-shape builders, severity
 *      derivation, human due/age labels, and the ranking + grouping. No I/O — same
 *      inputs, same outputs.
 *   2. LOADER (`collectInbox`): queries each source RLS-scoped through the caller's
 *      Supabase client and try/catches EACH source independently. A missing
 *      table/column (a source not yet migrated, e.g. `expense_reports`) DEGRADES
 *      that one source (reported in `degraded[]`) instead of failing the whole inbox.
 *
 * Read-only: no ledger post, no DB write. All money stays bigint cents.
 *
 * NOTE ON APPROVALS: "who may approve" is Core-identity-owned (canApprove, resolved
 * against core.memberships). This collector does not re-decide authorization; the
 * route computes a single `canApproveMoney` boolean for the caller and passes it in
 * so a pending approval the caller can actually clear is ranked as CRITICAL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCoreMap } from '@/lib/stitch-core';
import { collectObligations, type Obligation } from '@/lib/obligations/collect';

// ---------------------------------------------------------------------------
// Common shape
// ---------------------------------------------------------------------------

export type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';

/** UI grouping — the section an item renders under. */
export type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';

/** Urgency band (drives colour + intra-group ordering). */
export type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface InboxItem {
  /** Stable, cross-type-unique id: `${type}:${entity.id}`. */
  id: string;
  type: InboxItemType;
  group: InboxGroupKey;
  /** Short human title, e.g. "AP disbursement" or "Acme Co — INV-1042". */
  title: string;
  /** Optional secondary line. */
  subtitle: string | null;
  /** Human urgency string — "3d overdue", "due today", "5d ago", "just now". */
  dueOrAge: string;
  severity: InboxSeverity;
  /** Deep link to the record's approve/review/post surface. */
  actionHref: string;
  /** Verb for the act-on-it link, e.g. "Approve", "Resolve", "Review", "Post". */
  actionLabel: string;
  /** Money at stake where meaningful (bigint cents); null when N/A. */
  amountCents: number | null;
  /** The underlying record, for drill-through / dedupe. */
  entity: { table: string; id: string };
  /**
   * Ranking tiebreak within a (type, severity) bucket. Lower = more urgent.
   * For ALERTs this is days-until-due (negative = overdue → sorts first); for
   * everything else it is the NEGATED age in days, so the OLDEST waiting item
   * sorts first.
   */
  sortValue: number;
}

// ---------------------------------------------------------------------------
// PURE — grouping + rank tables
// ---------------------------------------------------------------------------

export const GROUP_FOR_TYPE: Record<InboxItemType, InboxGroupKey> = {
  APPROVAL: 'APPROVALS',
  POLICY_BLOCK: 'POLICY_BLOCKS',
  ALERT: 'ALERTS',
  EXCEPTION: 'EXCEPTIONS',
  DRAFT: 'DRAFTS',
};

/** Approvals + blocks first, then overdue obligations, then exceptions, then drafts. */
const TYPE_RANK: Record<InboxItemType, number> = {
  APPROVAL: 0,
  POLICY_BLOCK: 1,
  ALERT: 2,
  EXCEPTION: 3,
  DRAFT: 4,
};

const SEVERITY_RANK: Record<InboxSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** The order groups render on the screen. */
export const GROUP_ORDER: InboxGroupKey[] = [
  'APPROVALS',
  'POLICY_BLOCKS',
  'ALERTS',
  'EXCEPTIONS',
  'DRAFTS',
];

// ---------------------------------------------------------------------------
// PURE — date/age math
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a yyyy-mm-dd (or full ISO timestamp) to a UTC-midnight epoch, or null. */
function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/** Whole days elapsed from `iso` up to `asOf` (asOf - iso). Null if unparseable. */
export function ageInDays(asOf: string, iso: string | null | undefined): number | null {
  const a = isoToUtc(asOf);
  const b = isoToUtc(iso);
  if (a === null || b === null) return null;
  return Math.round((a - b) / MS_PER_DAY);
}

/** Human "how long has this been waiting" label from a whole-day age. */
export function formatAge(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const mo = Math.round(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** Human "when is this due" label from days-until-due (negative = overdue). */
export function formatDue(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'due today';
  return `in ${days}d`;
}

// ---------------------------------------------------------------------------
// PURE — severity derivation
// ---------------------------------------------------------------------------

/** A pending money-movement approval you can actually clear is top priority. */
export function severityForApproval(canApprove: boolean): InboxSeverity {
  return canApprove ? 'CRITICAL' : 'HIGH';
}

/** An overdue obligation is critical; due-this-week high; otherwise medium. */
export function severityForAlertDays(days: number): InboxSeverity {
  if (days < 0) return 'CRITICAL';
  if (days <= 7) return 'HIGH';
  return 'MEDIUM';
}

// ---------------------------------------------------------------------------
// PURE — helpers
// ---------------------------------------------------------------------------

function toNum(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/** Title-case a SNAKE_CASE token, e.g. AP_DISBURSEMENT → "AP disbursement". */
function humanizeToken(token: string | null | undefined, fallback: string): string {
  if (!token) return fallback;
  const spaced = token.replace(/_/g, ' ').trim();
  if (!spaced) return fallback;
  // Keep short all-caps acronyms (AP/AR) upper; sentence-case the rest.
  return spaced
    .split(' ')
    .map((w, i) =>
      w.length <= 2 ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase(),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// PURE — common-shape builders (one per source; each returns InboxItem | null)
// ---------------------------------------------------------------------------

export interface RawApproval {
  id: string;
  kind: string | null;
  subject_table: string | null;
  amount_cents: number | string | null;
  created_at: string | null;
}

/** Where an approval's act-on-it link points, by money-movement kind. */
function approvalTarget(kind: string | null): { href: string; label: string } {
  switch (kind) {
    case 'PAYROLL_RUN':
      return { href: '/payroll', label: 'Review' };
    case 'AR_REFUND':
      return { href: '/invoices', label: 'Approve' };
    case 'AP_DISBURSEMENT':
    case 'AP_BATCH':
      return { href: '/checks', label: 'Approve' };
    default:
      return { href: '/bills', label: 'Approve' };
  }
}

export function buildApprovalItem(asOf: string, r: RawApproval, canApprove: boolean): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  const { href, label } = approvalTarget(r.kind);
  return {
    id: `APPROVAL:${r.id}`,
    type: 'APPROVAL',
    group: 'APPROVALS',
    title: humanizeToken(r.kind, 'Approval required'),
    subtitle: r.subject_table
      ? `Pending your approval — ${r.subject_table.replace(/_/g, ' ')}`
      : 'Pending your approval',
    dueOrAge: formatAge(age),
    severity: severityForApproval(canApprove),
    actionHref: href,
    actionLabel: canApprove ? label : 'View',
    amountCents: toNum(r.amount_cents) !== null ? Math.abs(toNum(r.amount_cents)!) : null,
    entity: { table: 'approvals', id: r.id },
    sortValue: -age,
  };
}

export interface RawExpenseReport {
  id: string;
  title: string | null;
  total_cents: number | string | null;
  policy_flag_count: number | string | null;
  status: string | null;
  submitted_at: string | null;
  created_at: string | null;
}

/** A SUBMITTED expense report is an approval; a DRAFT with policy flags is a block. */
export function buildExpenseReportItem(asOf: string, r: RawExpenseReport, canApprove: boolean): InboxItem | null {
  const flags = toNum(r.policy_flag_count) ?? 0;
  const total = toNum(r.total_cents);
  const amountCents = total !== null ? Math.abs(total) : null;

  if (r.status === 'SUBMITTED') {
    const age = ageInDays(asOf, r.submitted_at ?? r.created_at) ?? 0;
    return {
      id: `APPROVAL:expense_report:${r.id}`,
      type: 'APPROVAL',
      group: 'APPROVALS',
      title: r.title || 'Expense report',
      subtitle: flags > 0 ? `Expense report — ${flags} policy flag${flags === 1 ? '' : 's'}` : 'Expense report awaiting approval',
      dueOrAge: formatAge(age),
      severity: severityForApproval(canApprove),
      actionHref: '/expenses',
      actionLabel: canApprove ? 'Approve' : 'View',
      amountCents,
      entity: { table: 'expense_reports', id: r.id },
      sortValue: -age,
    };
  }

  if (r.status === 'DRAFT' && flags > 0) {
    const age = ageInDays(asOf, r.created_at) ?? 0;
    return {
      id: `POLICY_BLOCK:expense_report:${r.id}`,
      type: 'POLICY_BLOCK',
      group: 'POLICY_BLOCKS',
      title: r.title || 'Expense report',
      subtitle: `${flags} expense-policy flag${flags === 1 ? '' : 's'} to resolve before submit`,
      dueOrAge: formatAge(age),
      severity: 'HIGH',
      actionHref: '/expenses',
      actionLabel: 'Review',
      amountCents,
      entity: { table: 'expense_reports', id: r.id },
      sortValue: -age,
    };
  }

  return null;
}

export interface RawBillHold {
  id: string;
  bill_number: string | null;
  total_cents: number | string | null;
  payment_hold_reason: string | null;
  vendor_id: string | null;
  created_at: string | null;
}

export function buildBillHoldItem(asOf: string, r: RawBillHold, vendorName: string | null): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  const amt = toNum(r.total_cents);
  return {
    id: `POLICY_BLOCK:bill:${r.id}`,
    type: 'POLICY_BLOCK',
    group: 'POLICY_BLOCKS',
    title: `${vendorName ?? 'Unknown vendor'} — ${r.bill_number ?? 'No #'}`,
    subtitle: r.payment_hold_reason ?? 'Payment hold — AP policy block',
    dueOrAge: formatAge(age),
    severity: 'HIGH',
    actionHref: '/bills',
    actionLabel: 'Resolve',
    amountCents: amt !== null ? Math.abs(amt) : null,
    entity: { table: 'bills', id: r.id },
    sortValue: -age,
  };
}

export interface RawAiProposal {
  id: string;
  feature: string | null;
  input_summary: string | null;
  confidence: number | string | null;
  proposed_output: { disposition?: unknown } | null;
  created_at: string | null;
}

const ESCALATED_DISPOSITIONS = new Set(['ESCALATE', 'BLOCKED']);

export function buildAiProposalItem(asOf: string, r: RawAiProposal): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  const dispo = typeof r.proposed_output?.disposition === 'string' ? r.proposed_output.disposition : null;
  const conf = toNum(r.confidence);
  // Escalated / blocked dispositions are HIGH; everything else MEDIUM.
  const severity: InboxSeverity = dispo && ESCALATED_DISPOSITIONS.has(dispo) ? 'HIGH' : 'MEDIUM';
  return {
    id: `EXCEPTION:${r.id}`,
    type: 'EXCEPTION',
    group: 'EXCEPTIONS',
    title: r.input_summary || 'AI proposal',
    subtitle:
      (r.feature ? humanizeToken(r.feature, 'AI proposal') : 'Awaiting human review') +
      (conf !== null ? ` · ${Math.round(conf * 100)}% confidence` : ''),
    dueOrAge: formatAge(age),
    severity,
    actionHref: '/exceptions',
    actionLabel: 'Review',
    amountCents: null,
    entity: { table: 'ai_decisions', id: r.id },
    sortValue: -age,
  };
}

/** Map an overdue/soon obligation (from the obligations collector) to an ALERT. */
export function buildObligationItem(o: Obligation): InboxItem {
  return {
    id: `ALERT:${o.type}:${o.entityId}`,
    type: 'ALERT',
    group: 'ALERTS',
    title: o.title,
    subtitle: o.subtitle,
    dueOrAge: formatDue(o.daysUntil),
    severity: severityForAlertDays(o.daysUntil),
    actionHref: o.href,
    actionLabel: 'Review',
    amountCents: o.amountCents,
    entity: { table: o.type.toLowerCase(), id: o.entityId },
    sortValue: o.daysUntil,
  };
}

export interface RawJeDraft {
  id: string;
  entry_number: string | null;
  memo: string | null;
  source_module: string | null;
  created_at: string | null;
}

export function buildJeDraftItem(asOf: string, r: RawJeDraft): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  return {
    id: `DRAFT:je:${r.id}`,
    type: 'DRAFT',
    group: 'DRAFTS',
    title: `${r.entry_number ?? 'Draft entry'}${r.memo ? ` — ${r.memo}` : ''}`,
    subtitle: 'Unposted journal entry — review and post',
    dueOrAge: formatAge(age),
    severity: 'LOW',
    actionHref: '/journal-entries',
    actionLabel: 'Post',
    amountCents: null,
    entity: { table: 'gl_entries', id: r.id },
    sortValue: -age,
  };
}

// ---------------------------------------------------------------------------
// PURE — ranking + grouping + counts
// ---------------------------------------------------------------------------

/**
 * Deterministic ranking: approvals + policy blocks first, then overdue alerts,
 * then exceptions, then drafts; within a type the more severe first; then the
 * most urgent/oldest (sortValue); then title — stable, never query-order-dependent.
 */
export function rankInboxItems(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (t !== 0) return t;
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.sortValue !== b.sortValue) return a.sortValue - b.sortValue;
    return a.title.localeCompare(b.title);
  });
}

export interface InboxGroup {
  key: InboxGroupKey;
  items: InboxItem[];
}

/** Group ranked items into the ordered sections (each section stays ranked). */
export function groupInboxItems(items: readonly InboxItem[]): InboxGroup[] {
  const ranked = rankInboxItems(items);
  return GROUP_ORDER.map((key) => ({
    key,
    items: ranked.filter((i) => i.group === key),
  })).filter((g) => g.items.length > 0);
}

/** Count by item type — powers the header/badge summary. */
export function countsByType(items: readonly InboxItem[]): Record<InboxItemType, number> {
  const counts: Record<InboxItemType, number> = {
    APPROVAL: 0,
    POLICY_BLOCK: 0,
    ALERT: 0,
    EXCEPTION: 0,
    DRAFT: 0,
  };
  for (const i of items) counts[i.type] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// LOADER — one RLS-scoped query per source, each degrade-isolated
// ---------------------------------------------------------------------------

export interface CollectInboxOptions {
  /** yyyy-mm-dd "today". */
  asOf: string;
  /** Whether the caller has money-movement approval authority (from canApprove). */
  canApproveMoney: boolean;
  /**
   * How far out an obligation counts as an alert (overdue always included).
   * Default 30 — the inbox is "act now", not the full renewals calendar.
   */
  alertHorizonDays?: number;
}

export interface CollectInboxResult {
  items: InboxItem[];
  groups: InboxGroup[];
  counts: { total: number; byType: Record<InboxItemType, number> };
  /** Source keys that could not be read (missing table/column, query error). */
  degraded: string[];
}

const SOURCE_CAP = 100;

async function collectApprovals(supabase: SupabaseClient, asOf: string, canApprove: boolean): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from('approvals')
    .select('id, kind, subject_table, amount_cents, created_at')
    .eq('status', 'PENDING_APPROVAL')
    .order('created_at', { ascending: true })
    .limit(SOURCE_CAP);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RawApproval[]).map((r) => buildApprovalItem(asOf, r, canApprove));
}

async function collectExpenseReports(supabase: SupabaseClient, asOf: string, canApprove: boolean): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from('expense_reports')
    .select('id, title, total_cents, policy_flag_count, status, submitted_at, created_at')
    .in('status', ['SUBMITTED', 'DRAFT'])
    .order('created_at', { ascending: true })
    .limit(SOURCE_CAP);
  if (error) throw new Error(error.message);
  const out: InboxItem[] = [];
  for (const r of (data ?? []) as RawExpenseReport[]) {
    const item = buildExpenseReportItem(asOf, r, canApprove);
    if (item) out.push(item);
  }
  return out;
}

async function collectBillHolds(supabase: SupabaseClient, asOf: string): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from('bills')
    .select('id, bill_number, total_cents, payment_hold_reason, vendor_id, created_at')
    .eq('status', 'ON_HOLD')
    .order('created_at', { ascending: true })
    .limit(SOURCE_CAP);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RawBillHold[];
  // Stitch vendor names (cross-schema embed doesn't work — see stitch-core).
  const venMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase,
    'vendors',
    'id, name',
    rows.map((b) => b.vendor_id),
  );
  return rows.map((r) => buildBillHoldItem(asOf, r, r.vendor_id ? venMap.get(r.vendor_id)?.name ?? null : null));
}

async function collectAiProposals(supabase: SupabaseClient, asOf: string): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from('ai_decisions')
    .select('id, feature, input_summary, confidence, proposed_output, created_at')
    .eq('status', 'PROPOSED')
    .order('created_at', { ascending: false })
    .limit(SOURCE_CAP);
  if (error) throw new Error(error.message);
  return ((data ?? []) as RawAiProposal[]).map((r) => buildAiProposalItem(asOf, r));
}

async function collectAlerts(supabase: SupabaseClient, asOf: string, horizonDays: number): Promise<InboxItem[]> {
  // Reuse the obligations collector; the inbox only surfaces the near-term slice.
  const { obligations } = await collectObligations(supabase, { asOf, horizonDays });
  return obligations.filter((o) => o.daysUntil <= horizonDays).map(buildObligationItem);
}

async function collectJeDrafts(supabase: SupabaseClient, asOf: string): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from('gl_entries')
    .select('id, entry_number, memo, source_module, created_at, status')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(SOURCE_CAP);
  if (error) throw new Error(error.message);
  // Only surface MANUAL (or unattributed) drafts a human is expected to post; system
  // modules post their own entries and would only be noise here.
  return ((data ?? []) as Array<RawJeDraft & { source_module: string | null }>)
    .filter((r) => r.source_module == null || r.source_module === 'MANUAL')
    .map((r) => buildJeDraftItem(asOf, r));
}

/**
 * Gather everything that needs the caller right now, ranked.
 *
 * Each source is queried RLS-scoped and try/catched INDEPENDENTLY: a missing
 * table/column or query error degrades that one source (recorded in `degraded`)
 * rather than failing the whole inbox. The obligations source is itself a
 * degrade-isolated aggregate, so a missing renewals table never breaks the inbox.
 */
export async function collectInbox(
  supabase: SupabaseClient,
  opts: CollectInboxOptions,
): Promise<CollectInboxResult> {
  const { asOf, canApproveMoney } = opts;
  const alertHorizonDays = opts.alertHorizonDays ?? 30;

  const sources: Array<[string, () => Promise<InboxItem[]>]> = [
    ['approvals', () => collectApprovals(supabase, asOf, canApproveMoney)],
    ['expense_reports', () => collectExpenseReports(supabase, asOf, canApproveMoney)],
    ['bill_holds', () => collectBillHolds(supabase, asOf)],
    ['ai_proposals', () => collectAiProposals(supabase, asOf)],
    ['alerts', () => collectAlerts(supabase, asOf, alertHorizonDays)],
    ['je_drafts', () => collectJeDrafts(supabase, asOf)],
  ];

  const degraded: string[] = [];
  const results = await Promise.all(
    sources.map(async ([key, fn]) => {
      try {
        return await fn();
      } catch (e) {
        console.error(`[inbox] source '${key}' degraded:`, e instanceof Error ? e.message : e);
        degraded.push(key);
        return [] as InboxItem[];
      }
    }),
  );

  const items = rankInboxItems(results.flat());
  const byType = countsByType(items);

  return {
    items,
    groups: groupInboxItems(items),
    counts: { total: items.length, byType },
    degraded,
  };
}
