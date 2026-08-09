/**
 * Audit-trail READ layer (server-only).
 *
 * The write side lives in `lib/trust/action-log.ts` (append-only inserts to
 * core.action_log) and is intentionally NOT touched here — this module only
 * reads/queries/aggregates that spine for the reviewer surface (`/audit` +
 * `/api/audit/*`). It centralizes:
 *   - the module taxonomy (derive a friendly "module" from an action / subject),
 *   - filter parsing + a shared filter applier (list / export / summary agree),
 *   - actor-name resolution (admin lookup; core.users is self_read under RLS),
 *   - CSV serialization for the auditor export,
 *   - in-app aggregation for the per-actor / per-module summary.
 *
 * Every read is org-scoped: routes query through the RLS client (core.action_log
 * has an org_read policy) AND additionally `.eq('org_id', orgId)`. The admin
 * client is used ONLY to resolve display names of OTHER human actors (ids that
 * already came from org-scoped rows), never to widen the row set.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';
export type Tier = 'auto' | 'review' | 'escalate';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** Hard ceiling on rows a single CSV export streams (auditor-friendly, bounded). */
export const EXPORT_CAP = 25_000;
/** Rows scanned to compute the summary aggregates in-app (no GROUP BY / RPC). */
export const SUMMARY_CAP = 20_000;

// ── Module taxonomy ─────────────────────────────────────────────────────────
// Actions are dot-namespaced (e.g. 'gl.post', 'bankfeed.approve'); the segment
// before the first '.' is the reliable module key. subject_table is the fallback
// for the handful of legacy single-word actions. Labels are generic / white-label.

interface ModuleDef {
  key: string;
  label: string;
  /** action prefixes (segment before first '.') that belong to this module */
  prefixes: string[];
  /** subject_table values that belong to this module (fallback routing) */
  subjectTables: string[];
}

export const AUDIT_MODULES: ModuleDef[] = [
  { key: 'gl', label: 'General Ledger', prefixes: ['gl'], subjectTables: ['gl_entries'] },
  { key: 'journal', label: 'Journal Entries', prefixes: ['je', 'journal'], subjectTables: [] },
  { key: 'bankfeed', label: 'Bank Feed', prefixes: ['bankfeed'], subjectTables: ['bank_transactions'] },
  { key: 'reconciliation', label: 'Reconciliation', prefixes: ['reconciliation'], subjectTables: ['bank_reconciliations'] },
  { key: 'ap', label: 'Bills / AP', prefixes: ['bill', 'ap', 'ap_policy'], subjectTables: ['bills', 'ap_approval_policies', 'bill_po_links', 'vendor_payment_profiles', 'disbursement_check_numbers'] },
  { key: 'purchasing', label: 'Purchasing', prefixes: ['purchase_order', 'goods_receipt'], subjectTables: ['purchase_orders', 'goods_receipts'] },
  { key: 'ar', label: 'Invoices / AR', prefixes: ['invoice', 'collections'], subjectTables: ['invoices'] },
  { key: 'customers', label: 'Customers', prefixes: ['customer', 'customers'], subjectTables: ['customers'] },
  { key: 'vendors', label: 'Vendors', prefixes: ['vendor', 'vendors'], subjectTables: ['vendors'] },
  { key: 'payroll', label: 'Payroll', prefixes: ['payroll'], subjectTables: ['payroll_runs'] },
  { key: 'checks', label: 'Checks', prefixes: ['checks'], subjectTables: [] },
  { key: 'expenses', label: 'Expenses', prefixes: ['expense', 'expenses', 'expense_policy'], subjectTables: ['expense_reports', 'expense_policies'] },
  { key: 'inventory', label: 'Inventory', prefixes: ['inventory', 'inventory_item', 'inventory_movement', 'inventory_receipt'], subjectTables: ['inventory_items', 'inventory_movements'] },
  { key: 'close', label: 'Close Management', prefixes: ['close', 'period'], subjectTables: ['close_checklists', 'fiscal_periods', 'posting_schedules', 'recurring_templates'] },
  { key: 'controls', label: 'Controls', prefixes: ['controls', 'exception'], subjectTables: ['ai_decisions'] },
  { key: 'compliance', label: 'Compliance', prefixes: ['compliance'], subjectTables: [] },
  { key: 'approvals', label: 'Approvals', prefixes: ['approval', 'approvals'], subjectTables: ['approvals'] },
  { key: 'access', label: 'Access Control', prefixes: ['rbac', 'team', 'membership'], subjectTables: ['employees', 'custom_roles', 'role_permission_overrides', 'membership_invitations'] },
  { key: 'autonomy', label: 'AI Autonomy', prefixes: ['autonomy'], subjectTables: ['autonomy_settings', 'autonomy_kill_switch'] },
  { key: 'ai', label: 'AI Assist', prefixes: ['ai', 'nl', 'agent'], subjectTables: ['agent_runs'] },
];

const PREFIX_TO_MODULE = new Map<string, ModuleDef>();
const SUBJECT_TO_MODULE = new Map<string, ModuleDef>();
for (const m of AUDIT_MODULES) {
  for (const p of m.prefixes) PREFIX_TO_MODULE.set(p, m);
  for (const s of m.subjectTables) SUBJECT_TO_MODULE.set(s, m);
}

const OTHER_MODULE = { key: 'other', label: 'Other', prefixes: [], subjectTables: [] } as const;

/** Derive the { key, label } module for a row from its action + subject_table. */
export function moduleFor(action: string | null, subjectTable: string | null): { key: string; label: string } {
  if (action && action.includes('.')) {
    const prefix = action.slice(0, action.indexOf('.'));
    const m = PREFIX_TO_MODULE.get(prefix);
    if (m) return { key: m.key, label: m.label };
  }
  if (subjectTable) {
    const m = SUBJECT_TO_MODULE.get(subjectTable);
    if (m) return { key: m.key, label: m.label };
  }
  return { key: OTHER_MODULE.key, label: OTHER_MODULE.label };
}

/**
 * A PostgREST `.or()` clause selecting all rows whose module == key, matching on
 * either the action prefix (`action.ilike.gl.%`) OR the subject_table. Returns
 * null for an unknown key (caller should skip module filtering).
 */
export function moduleOrClause(key: string): string | null {
  const m = AUDIT_MODULES.find((x) => x.key === key);
  if (!m) return null;
  const parts: string[] = [];
  for (const p of m.prefixes) parts.push(`action.ilike.${p}.%`);
  for (const s of m.subjectTables) parts.push(`subject_table.eq.${s}`);
  return parts.length ? parts.join(',') : null;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface AuditFilters {
  actorType: ActorType | null;
  actorId: string | null; // core.users uuid (a specific human actor)
  action: string | null; // exact action string
  module: string | null; // module key
  from: string | null; // YYYY-MM-DD (inclusive, start of day)
  to: string | null; // YYYY-MM-DD (inclusive, end of day)
  subjectTable: string | null;
  subjectId: string | null;
  q: string | null; // free text across summary / action / subject_id
}

const ACTOR_TYPES: ActorType[] = ['HUMAN', 'AI', 'SYSTEM'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanStr(v: string | null, max = 200): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length ? t.slice(0, max) : null;
}

/** Sanitize free text so it can't break PostgREST `.or()` grammar. */
function cleanQuery(v: string | null): string | null {
  const t = cleanStr(v, 120);
  if (!t) return null;
  // Strip characters with meaning inside an or() filter list / ilike pattern.
  const safe = t.replace(/[,()*%\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe.length ? safe : null;
}

export function parseAuditFilters(sp: URLSearchParams): AuditFilters {
  const actorTypeRaw = sp.get('actorType');
  const from = cleanStr(sp.get('from'), 10);
  const to = cleanStr(sp.get('to'), 10);
  return {
    actorType: ACTOR_TYPES.includes(actorTypeRaw as ActorType) ? (actorTypeRaw as ActorType) : null,
    actorId: cleanStr(sp.get('actorId'), 64),
    action: cleanStr(sp.get('action'), 120),
    module: cleanStr(sp.get('module'), 40),
    from: from && DATE_RE.test(from) ? from : null,
    to: to && DATE_RE.test(to) ? to : null,
    subjectTable: cleanStr(sp.get('subjectTable'), 80),
    subjectId: cleanStr(sp.get('subjectId'), 128),
    q: cleanQuery(sp.get('q')),
  };
}

/**
 * Structural view of the Supabase filter builder — just the methods we chain.
 * Each returns the same builder type, so the applier is generic and keeps the
 * concrete type (letting callers continue with `.order()/.range()` after).
 */
interface AuditFilterBuilder<Self> {
  eq(column: string, value: string): Self;
  gte(column: string, value: string): Self;
  lte(column: string, value: string): Self;
  or(filters: string): Self;
}

/** Apply every active filter to a core.action_log query builder. */
export function applyAuditFilters<Q extends AuditFilterBuilder<Q>>(q: Q, f: AuditFilters): Q {
  let out = q;
  if (f.actorType) out = out.eq('actor_type', f.actorType);
  if (f.actorId) out = out.eq('actor_user_id', f.actorId);
  if (f.action) out = out.eq('action', f.action);
  if (f.subjectTable) out = out.eq('subject_table', f.subjectTable);
  if (f.subjectId) out = out.eq('subject_id', f.subjectId);
  if (f.from) out = out.gte('created_at', `${f.from}T00:00:00.000Z`);
  if (f.to) out = out.lte('created_at', `${f.to}T23:59:59.999Z`);
  if (f.module) {
    const clause = moduleOrClause(f.module);
    if (clause) out = out.or(clause);
  }
  if (f.q) {
    out = out.or(`summary.ilike.%${f.q}%,action.ilike.%${f.q}%,subject_id.ilike.%${f.q}%`);
  }
  return out;
}

// ── Actor-name resolution ───────────────────────────────────────────────────

interface CoreUserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/**
 * Resolve display names for HUMAN actor uuids in ONE lookup (no N+1). Uses the
 * admin client because core.users is self_read under RLS — the ids come from
 * org-scoped action_log rows, and only name fields are read, so this cannot leak
 * cross-tenant data. AI / SYSTEM rows never carry an actor id.
 */
export async function resolveActorNames(
  admin: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return nameById;

  const { data } = await admin
    .schema('core')
    .from('users')
    .select('id, first_name, last_name, email')
    .in('id', unique);

  for (const u of (data ?? []) as CoreUserRow[]) {
    const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
    nameById.set(u.id, full || u.email || 'Team member');
  }
  return nameById;
}

export function actorDisplayName(
  actorType: ActorType,
  actorUserId: string | null,
  nameById: Map<string, string>,
): string {
  if (actorType === 'AI') return 'AI';
  if (actorType === 'SYSTEM') return 'System';
  return (actorUserId && nameById.get(actorUserId)) || 'Team member';
}

// ── Row shapes shared across routes ─────────────────────────────────────────

export interface RawLogRow {
  id: string;
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  summary: string | null;
  subject_table: string | null;
  subject_id: string | null;
  tier: string | null;
  confidence: number | null;
  correlation_id?: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  actorType: ActorType;
  actorName: string;
  action: string;
  module: string;
  summary: string | null;
  subjectTable: string | null;
  subjectId: string | null;
  tier: string | null;
  confidence: number | null;
  createdAt: string;
}

export function toAuditRow(r: RawLogRow, nameById: Map<string, string>): AuditRow {
  return {
    id: r.id,
    actorType: r.actor_type,
    actorName: actorDisplayName(r.actor_type, r.actor_user_id, nameById),
    action: r.action,
    module: moduleFor(r.action, r.subject_table).label,
    summary: r.summary,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    tier: r.tier,
    confidence: r.confidence,
    createdAt: r.created_at,
  };
}

// ── Summary aggregation (in-app; no GROUP BY / RPC) ──────────────────────────

export interface SummaryRow {
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  subject_table: string | null;
  tier: string | null;
}

export interface AuditSummary {
  total: number;
  capped: boolean;
  byActorType: { actorType: ActorType; count: number }[];
  byTier: { tier: string; count: number }[];
  byActor: { actorId: string | null; actorType: ActorType; actorName: string; count: number }[];
  byModule: { key: string; label: string; count: number }[];
  actions: { action: string; count: number }[];
}

export function summarize(rows: SummaryRow[], nameById: Map<string, string>, capped: boolean): AuditSummary {
  const actorTypeCounts = new Map<ActorType, number>();
  const tierCounts = new Map<string, number>();
  const moduleCounts = new Map<string, { label: string; count: number }>();
  const actionCounts = new Map<string, number>();
  // Actor key: HUMAN uses the uuid; AI/SYSTEM collapse to a synthetic key.
  const actorCounts = new Map<string, { actorId: string | null; actorType: ActorType; count: number }>();

  for (const r of rows) {
    actorTypeCounts.set(r.actor_type, (actorTypeCounts.get(r.actor_type) ?? 0) + 1);
    if (r.tier) tierCounts.set(r.tier, (tierCounts.get(r.tier) ?? 0) + 1);

    const m = moduleFor(r.action, r.subject_table);
    const prev = moduleCounts.get(m.key);
    moduleCounts.set(m.key, { label: m.label, count: (prev?.count ?? 0) + 1 });

    actionCounts.set(r.action, (actionCounts.get(r.action) ?? 0) + 1);

    const actorKey = r.actor_type === 'HUMAN' ? `H:${r.actor_user_id ?? 'unknown'}` : `T:${r.actor_type}`;
    const pa = actorCounts.get(actorKey);
    actorCounts.set(actorKey, {
      actorId: r.actor_type === 'HUMAN' ? r.actor_user_id : null,
      actorType: r.actor_type,
      count: (pa?.count ?? 0) + 1,
    });
  }

  const byActor = Array.from(actorCounts.values())
    .map((a) => ({ ...a, actorName: actorDisplayName(a.actorType, a.actorId, nameById) }))
    .sort((a, b) => b.count - a.count);

  const byModule = Array.from(moduleCounts.entries())
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const actions = Array.from(actionCounts.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

  const orderedActorTypes: ActorType[] = ['HUMAN', 'AI', 'SYSTEM'];

  return {
    total: rows.length,
    capped,
    byActorType: orderedActorTypes
      .filter((t) => actorTypeCounts.has(t))
      .map((t) => ({ actorType: t, count: actorTypeCounts.get(t)! })),
    byTier: Array.from(tierCounts.entries())
      .map(([tier, count]) => ({ tier, count }))
      .sort((a, b) => b.count - a.count),
    byActor,
    byModule,
    actions,
  };
}

// ── CSV serialization ────────────────────────────────────────────────────────

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = [
  'Timestamp (UTC)',
  'Actor Type',
  'Actor',
  'Module',
  'Action',
  'Summary',
  'Subject Table',
  'Subject ID',
  'Tier',
  'Confidence %',
] as const;

/** Serialize resolved rows to a CSV string (with a UTF-8 BOM for Excel). */
export function toCsv(rows: AuditRow[]): string {
  const lines: string[] = [CSV_HEADERS.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt,
        r.actorType,
        r.actorName,
        r.module,
        r.action,
        r.summary ?? '',
        r.subjectTable ?? '',
        r.subjectId ?? '',
        r.tier ?? '',
        r.confidence != null ? Math.round(r.confidence * 100) : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM so Excel opens UTF-8 correctly; CRLF line endings per RFC 4180.
  return '﻿' + lines.join('\r\n');
}
