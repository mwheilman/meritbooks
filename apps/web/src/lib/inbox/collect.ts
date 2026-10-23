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
import { fetchAll, type PageableQuery } from '@/lib/supabase/fetch-all';
import { collectObligations, type Obligation } from '@/lib/obligations/collect';

// ---------------------------------------------------------------------------
// Common shape
// ---------------------------------------------------------------------------

export type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';

/** UI grouping — the section an item renders under. */
export type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';

/** Urgency band (drives colour + intra-group ordering). */
export type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * The Inbox TAB an item lives in. Every item is in exactly ONE lane, so the four tab
 * counts always sum to the "needs you" total (lib/work/needs-attention):
 *   approvals  → money-movement + expense approvals and policy blocks
 *   exceptions → AI proposals + flagged bank lines / receipts + job costs to approve
 *   alerts     → overdue / near-term obligations
 *   drafts     → unposted manual journal entries
 */
export type WorkLane = 'approvals' | 'exceptions' | 'alerts' | 'drafts';

/** The underlying queue an item came from (finer than the lane). */
export type WorkSource =
  | 'approval'
  | 'expense_report'
  | 'expense_policy'
  | 'bill_hold'
  | 'ai_proposal'
  | 'bank'
  | 'receipt'
  | 'cost'
  | 'obligation'
  | 'je_draft';

/** Advisory autonomy disposition an AI proposal recorded (ai_proposal only). */
export type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';
const DISPOSITIONS: readonly Disposition[] = ['AUTO', 'REVIEW', 'ESCALATE', 'BLOCKED'];

export function toDisposition(raw: unknown): Disposition | null {
  return typeof raw === 'string' && (DISPOSITIONS as readonly string[]).includes(raw) ? (raw as Disposition) : null;
}

export const LANE_FOR_TYPE: Record<InboxItemType, WorkLane> = {
  APPROVAL: 'approvals',
  POLICY_BLOCK: 'approvals',
  ALERT: 'alerts',
  EXCEPTION: 'exceptions',
  DRAFT: 'drafts',
};

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
  /** Which Inbox tab this item counts in (exactly one). */
  lane: WorkLane;
  /** Which queue it came from. */
  source: WorkSource;
  /** The client (core.locations id) it belongs to; null = organization-level. */
  locationId: string | null;
  /** AI confidence 0..1 (ai_proposal only). */
  confidence: number | null;
  /** Advisory autonomy disposition (ai_proposal only). */
  disposition: Disposition | null;
  /** When the record was created (ISO), when known. */
  createdAt: string | null;
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
  subject_id?: string | null;
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

export function buildApprovalItem(
  asOf: string,
  r: RawApproval,
  canApprove: boolean,
  locationId: string | null = null,
): InboxItem {
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
    lane: 'approvals',
    source: 'approval',
    locationId,
    confidence: null,
    disposition: null,
    createdAt: r.created_at,
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
  location_id?: string | null;
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
      lane: 'approvals',
      source: 'expense_report',
      locationId: r.location_id ?? null,
      confidence: null,
      disposition: null,
      createdAt: r.submitted_at ?? r.created_at,
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
      lane: 'approvals',
      source: 'expense_policy',
      locationId: r.location_id ?? null,
      confidence: null,
      disposition: null,
      createdAt: r.created_at,
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
  location_id?: string | null;
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
    lane: 'approvals',
    source: 'bill_hold',
    locationId: r.location_id ?? null,
    confidence: null,
    disposition: null,
    createdAt: r.created_at,
  };
}

export interface RawAiProposal {
  id: string;
  feature: string | null;
  input_summary: string | null;
  confidence: number | string | null;
  proposed_output: { disposition?: unknown } | null;
  created_at: string | null;
  location_id?: string | null;
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
    actionHref: '/ai-decisions',
    actionLabel: 'Review',
    amountCents: null,
    entity: { table: 'ai_decisions', id: r.id },
    sortValue: -age,
    lane: 'exceptions',
    source: 'ai_proposal',
    locationId: r.location_id ?? null,
    confidence: conf,
    disposition: toDisposition(dispo),
    createdAt: r.created_at,
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
    lane: 'alerts',
    source: 'obligation',
    locationId: o.locationId ?? null,
    confidence: null,
    disposition: null,
    createdAt: null,
  };
}

export interface RawJeDraft {
  id: string;
  entry_number: string | null;
  memo: string | null;
  source_module: string | null;
  created_at: string | null;
  location_id?: string | null;
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
    lane: 'drafts',
    source: 'je_draft',
    locationId: r.location_id ?? null,
    confidence: null,
    disposition: null,
    createdAt: r.created_at,
  };
}

// --- Exceptions-lane sources (flagged lines, job costs) — the old /api/exceptions set ---

export interface RawBankFlag {
  id: string;
  description: string | null;
  amount_cents: number | string | null;
  ai_reasoning: string | null;
  created_at: string | null;
  location_id?: string | null;
}

export function buildBankFlagItem(asOf: string, r: RawBankFlag): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  const amt = toNum(r.amount_cents);
  return {
    id: `EXCEPTION:bank:${r.id}`,
    type: 'EXCEPTION',
    group: 'EXCEPTIONS',
    title: r.description || 'Bank transaction',
    subtitle: r.ai_reasoning || 'Flagged for review',
    dueOrAge: formatAge(age),
    severity: 'MEDIUM',
    actionHref: '/bank-feed',
    actionLabel: 'Review',
    amountCents: amt !== null ? Math.abs(amt) : null,
    entity: { table: 'bank_transactions', id: r.id },
    sortValue: -age,
    lane: 'exceptions',
    source: 'bank',
    locationId: r.location_id ?? null,
    confidence: null,
    disposition: null,
    createdAt: r.created_at,
  };
}

export interface RawReceiptFlag {
  id: string;
  vendor_name: string | null;
  amount_cents: number | string | null;
  submitted_at: string | null;
  location_id?: string | null;
}

export function buildReceiptFlagItem(asOf: string, r: RawReceiptFlag): InboxItem {
  const age = ageInDays(asOf, r.submitted_at) ?? 0;
  const amt = toNum(r.amount_cents);
  return {
    id: `EXCEPTION:receipt:${r.id}`,
    type: 'EXCEPTION',
    group: 'EXCEPTIONS',
    title: r.vendor_name || 'Unknown receipt',
    subtitle: 'Flagged receipt — requires manual review',
    dueOrAge: formatAge(age),
    severity: 'MEDIUM',
    actionHref: '/receipts',
    actionLabel: 'Review',
    amountCents: amt !== null ? Math.abs(amt) : null,
    entity: { table: 'receipts', id: r.id },
    sortValue: -age,
    lane: 'exceptions',
    source: 'receipt',
    locationId: r.location_id ?? null,
    confidence: null,
    disposition: null,
    createdAt: r.submitted_at,
  };
}

export interface RawCostPending {
  id: string;
  cost_type: string | null;
  memo: string | null;
  amount_cents: number | string | null;
  created_at: string | null;
  location_id?: string | null;
}

export function buildCostItem(asOf: string, r: RawCostPending): InboxItem {
  const age = ageInDays(asOf, r.created_at) ?? 0;
  const amt = toNum(r.amount_cents);
  const typeLabel = r.cost_type ? r.cost_type.toLowerCase() : 'cost';
  return {
    id: `EXCEPTION:cost:${r.id}`,
    type: 'EXCEPTION',
    group: 'EXCEPTIONS',
    title: r.memo || `Job cost — ${typeLabel}`,
    subtitle: `Job cost approval — ${typeLabel}`,
    dueOrAge: formatAge(age),
    severity: 'MEDIUM',
    // No standalone cost-approvals page exists yet; resolve alongside bills.
    actionHref: '/bills',
    actionLabel: 'Review',
    amountCents: amt !== null ? Math.abs(amt) : null,
    entity: { table: 'job_cost_attributions', id: r.id },
    sortValue: -age,
    lane: 'exceptions',
    source: 'cost',
    locationId: r.location_id ?? null,
    confidence: null,
    disposition: null,
    createdAt: r.created_at,
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
  /**
   * Pin every source to ONE client (core.locations id). Null/absent = every client the
   * caller's RLS lets them see (plus organization-level items). This is a sub-filter
   * inside RLS — the client must already be validated against the caller's client
   * scope (lib/work/needs-attention resolveWorkScope) before it is passed here.
   */
  locationId?: string | null;
}

export interface CollectInboxResult {
  items: InboxItem[];
  groups: InboxGroup[];
  counts: { total: number; byType: Record<InboxItemType, number> };
  /** Source keys that could not be read (missing table/column, query error). */
  degraded: string[];
}

type Row = Record<string, unknown>;

/**
 * Read EVERY row of a source (paged past PostgREST's 1,000-row cap) so counts are exact
 * — the old 100-row cap made the Inbox say "100" while the queue held 109.
 */
async function readAll(label: string, make: () => PageableQuery<Row>): Promise<Row[]> {
  const { data, error } = await fetchAll<Row>(make, { label: `inbox ${label}` });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Approvals carry no location of their own — the client is the SUBJECT's (a bill, an
 * invoice, a payroll run …). Tables here all have `location_id` (verified against the
 * live schema). Anything else stays organization-level (null).
 */
const APPROVAL_SUBJECTS_WITH_LOCATION = [
  'bills',
  'bill_payments',
  'invoices',
  'payroll_runs',
  'expense_reports',
  'bank_transactions',
  'payment_origination_batches',
  'purchase_orders',
  'gl_entries',
] as const;
type ApprovalSubjectTable = (typeof APPROVAL_SUBJECTS_WITH_LOCATION)[number];

function isLocatedSubject(t: string | null | undefined): t is ApprovalSubjectTable {
  return !!t && (APPROVAL_SUBJECTS_WITH_LOCATION as readonly string[]).includes(t);
}

export interface ApprovalLocations {
  /** approval id → the subject's client. */
  locations: Map<string, string>;
  /**
   * Approvals whose located subject the caller can NOT see (out of their client scope —
   * RLS hid the row — or the lookup failed). These are dropped from the Inbox, never
   * re-filed as organization-level: the approval would otherwise leak the subject's
   * amount and kind to someone outside that client.
   */
  hidden: Set<string>;
}

/**
 * Resolve each approval's client through its subject row, read through the CALLER's RLS
 * client (so client scope applies). Fails closed per table: a subject that cannot be read
 * hides its approvals.
 */
export async function resolveApprovalLocations(
  supabase: SupabaseClient,
  rows: readonly RawApproval[],
): Promise<ApprovalLocations> {
  const byTable = new Map<ApprovalSubjectTable, Set<string>>();
  for (const r of rows) {
    if (!isLocatedSubject(r.subject_table) || !r.subject_id) continue;
    const set = byTable.get(r.subject_table) ?? new Set<string>();
    set.add(r.subject_id);
    byTable.set(r.subject_table, set);
  }
  const visible = new Set<string>(); // `${table}:${id}` the caller can read
  const subjectLoc = new Map<string, string>(); // `${table}:${id}` → location
  await Promise.all(
    Array.from(byTable.entries()).map(async ([table, ids]) => {
      try {
        const { data, error } = await supabase.from(table).select('id, location_id').in('id', Array.from(ids));
        if (error) return; // unreadable → every approval on this table stays hidden
        for (const r of (data ?? []) as Array<{ id: string; location_id: string | null }>) {
          visible.add(`${table}:${r.id}`);
          if (r.location_id) subjectLoc.set(`${table}:${r.id}`, r.location_id);
        }
      } catch {
        /* unreadable → hidden */
      }
    }),
  );
  const locations = new Map<string, string>();
  const hidden = new Set<string>();
  for (const r of rows) {
    if (!isLocatedSubject(r.subject_table) || !r.subject_id) continue; // genuinely organization-level
    const key = `${r.subject_table}:${r.subject_id}`;
    if (!visible.has(key)) {
      hidden.add(r.id);
      continue;
    }
    const loc = subjectLoc.get(key);
    if (loc) locations.set(r.id, loc);
  }
  return { locations, hidden };
}

async function collectApprovals(
  supabase: SupabaseClient,
  asOf: string,
  canApprove: boolean,
  locationId: string | null,
): Promise<InboxItem[]> {
  const rows = (await readAll('approvals', () =>
    supabase
      .from('approvals')
      .select('id, kind, subject_table, subject_id, amount_cents, created_at')
      .eq('status', 'PENDING_APPROVAL'),
  )) as unknown as RawApproval[];
  const { locations, hidden } = await resolveApprovalLocations(supabase, rows);
  const items = rows
    .filter((r) => !hidden.has(r.id))
    .map((r) => buildApprovalItem(asOf, r, canApprove, locations.get(r.id) ?? null));
  // Approvals can't be filtered in SQL (the client is the subject's) — filter here.
  return locationId ? items.filter((i) => i.locationId === locationId) : items;
}

async function collectExpenseReports(
  supabase: SupabaseClient,
  asOf: string,
  canApprove: boolean,
  locationId: string | null,
): Promise<InboxItem[]> {
  const rows = (await readAll('expense_reports', () => {
    let q = supabase
      .from('expense_reports')
      .select('id, title, total_cents, policy_flag_count, status, submitted_at, created_at, location_id')
      .in('status', ['SUBMITTED', 'DRAFT']);
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawExpenseReport[];
  const out: InboxItem[] = [];
  for (const r of rows) {
    const item = buildExpenseReportItem(asOf, r, canApprove);
    if (item) out.push(item);
  }
  return out;
}

async function collectBillHolds(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  const rows = (await readAll('bill_holds', () => {
    let q = supabase
      .from('bills')
      .select('id, bill_number, total_cents, payment_hold_reason, vendor_id, created_at, location_id')
      .eq('status', 'ON_HOLD');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawBillHold[];
  // Stitch vendor names (cross-schema embed doesn't work — see stitch-core).
  const venMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase,
    'vendors',
    'id, name',
    rows.map((b) => b.vendor_id),
  );
  return rows.map((r) => buildBillHoldItem(asOf, r, r.vendor_id ? venMap.get(r.vendor_id)?.name ?? null : null));
}

async function collectAiProposals(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  const rows = (await readAll('ai_proposals', () => {
    let q = supabase
      .from('ai_decisions')
      .select('id, feature, input_summary, confidence, proposed_output, created_at, location_id')
      .eq('status', 'PROPOSED');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawAiProposal[];
  return rows.map((r) => buildAiProposalItem(asOf, r));
}

async function collectBankFlags(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  const rows = (await readAll('bank_flags', () => {
    let q = supabase
      .from('bank_transactions')
      .select('id, description, amount_cents, ai_reasoning, created_at, location_id')
      .eq('status', 'FLAGGED');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawBankFlag[];
  return rows.map((r) => buildBankFlagItem(asOf, r));
}

async function collectReceiptFlags(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  const rows = (await readAll('receipt_flags', () => {
    let q = supabase
      .from('receipts')
      .select('id, vendor_name, amount_cents, submitted_at, location_id')
      .eq('status', 'FLAGGED');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawReceiptFlag[];
  return rows.map((r) => buildReceiptFlagItem(asOf, r));
}

async function collectCostsPending(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  const rows = (await readAll('job_costs', () => {
    let q = supabase
      .from('job_cost_attributions')
      .select('id, cost_type, memo, amount_cents, created_at, location_id')
      .eq('lifecycle', 'PENDING');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawCostPending[];
  return rows.map((r) => buildCostItem(asOf, r));
}

async function collectAlerts(
  supabase: SupabaseClient,
  asOf: string,
  horizonDays: number,
  locationId: string | null,
): Promise<InboxItem[]> {
  // Reuse the obligations collector; the inbox only surfaces the near-term slice.
  const { obligations } = await collectObligations(supabase, { asOf, horizonDays });
  return obligations
    .filter((o) => o.daysUntil <= horizonDays)
    .filter((o) => !locationId || o.locationId === locationId)
    .map(buildObligationItem);
}

async function collectJeDrafts(supabase: SupabaseClient, asOf: string, locationId: string | null): Promise<InboxItem[]> {
  // gl_entries.status is transaction_status_enum (PENDING … POSTED, VOIDED) — there is
  // no 'DRAFT' value; an unposted entry is PENDING.
  const rows = (await readAll('je_drafts', () => {
    let q = supabase
      .from('gl_entries')
      .select('id, entry_number, memo, source_module, created_at, status, location_id')
      .eq('status', 'PENDING');
    if (locationId) q = q.eq('location_id', locationId);
    return q;
  })) as unknown as RawJeDraft[];
  // Only surface MANUAL (or unattributed) drafts a human is expected to post; system
  // modules post their own entries and would only be noise here.
  return rows.filter((r) => isManualDraft(r.source_module)).map((r) => buildJeDraftItem(asOf, r));
}

/** A draft a human is expected to post (manual or unattributed). */
export function isManualDraft(sourceModule: string | null | undefined): boolean {
  return sourceModule == null || sourceModule === 'MANUAL';
}

/**
 * Gather everything that needs the caller right now, ranked — every Inbox lane.
 *
 * Each source is queried RLS-scoped and try/catched INDEPENDENTLY: a missing
 * table/column or query error degrades that one source (recorded in `degraded`)
 * rather than failing the whole inbox. The obligations source is itself a
 * degrade-isolated aggregate, so a missing renewals table never breaks the inbox.
 *
 * Prefer lib/work/needs-attention `loadNeedsAttention` from routes and pages — it
 * validates the client against the caller's scope and produces the shared counts.
 */
export async function collectInbox(
  supabase: SupabaseClient,
  opts: CollectInboxOptions,
): Promise<CollectInboxResult> {
  const { asOf, canApproveMoney } = opts;
  const alertHorizonDays = opts.alertHorizonDays ?? 30;
  const loc = opts.locationId ?? null;

  const sources: Array<[string, () => Promise<InboxItem[]>]> = [
    ['approvals', () => collectApprovals(supabase, asOf, canApproveMoney, loc)],
    ['expense_reports', () => collectExpenseReports(supabase, asOf, canApproveMoney, loc)],
    ['bill_holds', () => collectBillHolds(supabase, asOf, loc)],
    ['ai_proposals', () => collectAiProposals(supabase, asOf, loc)],
    ['bank_flags', () => collectBankFlags(supabase, asOf, loc)],
    ['receipt_flags', () => collectReceiptFlags(supabase, asOf, loc)],
    ['job_costs', () => collectCostsPending(supabase, asOf, loc)],
    ['alerts', () => collectAlerts(supabase, asOf, alertHorizonDays, loc)],
    ['je_drafts', () => collectJeDrafts(supabase, asOf, loc)],
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

  // Belt and braces: a pinned client never returns another client's row, whatever a
  // source did (SQL eq above; approvals/alerts filtered in JS).
  const all = results.flat();
  const items = rankInboxItems(loc ? all.filter((i) => i.locationId === loc) : all);
  const byType = countsByType(items);

  return {
    items,
    groups: groupInboxItems(items),
    counts: { total: items.length, byType },
    degraded,
  };
}
