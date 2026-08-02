/**
 * Controls / SOX Compliance Command Center — the read-only aggregate of the whole
 * trust & controls surface.
 *
 * This is the "are the controls operating?" view a controller / auditor opens to
 * see, at a glance, the STATE of every financial control MeritBooks runs. It does
 * NOT run detectors, move money, or write anything — it READS the artifacts the
 * rest of the system already produces and shapes them into a control catalog with a
 * per-control status:
 *
 *   - the exception library            → public.ai_decisions (PROPOSED = open,
 *                                         APPROVED/REJECTED = cleared) + the
 *                                         proposed_output meta (control class,
 *                                         $-at-risk, autonomy disposition, money-out).
 *   - money-movement segregation of    → public.approvals (prepared_by / approved_by /
 *     duties (SoD)                        released_by; the DB CHECK guarantees
 *                                         approver≠preparer, and we ALSO detect any
 *                                         releaser==preparer weakness + surface the
 *                                         positive dual-control evidence).
 *   - AI supervision / autonomy posture → autonomy_settings + autonomy_kill_switch,
 *                                         cross-walked against the autonomy catalog
 *                                         (canon §3: auto-post OFF by default; SoD on
 *                                         the AI itself; a per-tenant, per-task dial).
 *   - audit-trail completeness         → core.action_log (HUMAN / AI / SYSTEM actor
 *                                         attribution — every action → the Decision Log).
 *
 * The SHAPING is PURE (I/O-free) and unit-tested against fixtures; `loadComplianceCenter`
 * does the RLS-scoped reads and DEGRADES SAFE (a missing autonomy table, or any query
 * error on a best-effort source, resolves to the most conservative reading rather than
 * throwing). All money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutonomyMode, Disposition } from '@/lib/autonomy/disposition';
import type { ActorType } from '@/lib/trust/action-log';
import { AUTONOMY_FEATURES, AUTONOMY_FEATURE_MAP } from '@/lib/autonomy/catalog';

// ─────────────────────────────────────────────────────────────────────────────
// Public status vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** A control's operating state. pass = green, warn = amber, fail = red. */
export type ControlStatus = 'pass' | 'warn' | 'fail';

/** Drill-through destinations (existing screens; never invented). */
export const EXCEPTIONS_HREF = '/exceptions';
export const AUDIT_HREF = '/audit';
export const AUTONOMY_HREF = '/settings/autonomy';

// ─────────────────────────────────────────────────────────────────────────────
// Raw (already-loaded) input shapes — the pure layer works ONLY on these
// ─────────────────────────────────────────────────────────────────────────────

/** One normalized ai_decisions row (an exception-library artifact). */
export interface ExceptionRow {
  feature: string;
  status: string; // PROPOSED (open) | APPROVED | REJECTED | ...
  confidence: number | null;
  amountAtRiskCents: number | null; // proposed_output.amount_at_risk_cents
  disposition: Disposition | null; // proposed_output.disposition
  moneyAlreadyOut: boolean; // proposed_output.money_already_out
  level: string | null; // payment-fraud: 'block' | 'review'
  createdAt: string;
}

/** One normalized approvals row (a money-movement SoD artifact). */
export interface ApprovalRow {
  id: string;
  kind: string;
  status: string;
  amountCents: number | null;
  preparedBy: string;
  approvedBy: string | null;
  releasedBy: string | null;
}

/** A resolved per-feature autonomy dial (null-row features are added by the shaper). */
export interface LoadedAutonomySetting {
  feature: string;
  mode: AutonomyMode;
  materialityLimitCents: number | null;
}

/** One action_log row, reduced to what completeness scoring needs. */
export interface AuditActionRow {
  actorType: ActorType;
  createdAt: string;
}

export interface ComplianceInputs {
  exceptions: ExceptionRow[];
  approvals: ApprovalRow[];
  autonomySettings: LoadedAutonomySetting[];
  killSwitchEngaged: boolean;
  auditActions: AuditActionRow[];
  /** ISO now (injectable for deterministic tests). */
  now?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exception aggregation (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureAggregate {
  feature: string;
  open: number; // status === 'PROPOSED'
  cleared: number; // status === 'APPROVED'
  rejected: number; // status === 'REJECTED'
  /** open exposure only — cleared/rejected exposure is no longer "at risk". */
  exposureCents: number;
  /** open items that are ESCALATE / money already out / a payment BLOCK. */
  escalate: number;
  byDisposition: Record<Disposition, number>;
}

const OPEN_STATUS = 'PROPOSED';

function emptyDispositions(): Record<Disposition, number> {
  return { AUTO: 0, REVIEW: 0, ESCALATE: 0, BLOCKED: 0 };
}

/** An open exception is "critical" when a human MUST look: escalated, money already
 *  out the door, or a payment-fraud BLOCK. Drives a control to `fail`. */
export function isCriticalOpen(r: ExceptionRow): boolean {
  return (
    r.status === OPEN_STATUS &&
    (r.disposition === 'ESCALATE' ||
      r.moneyAlreadyOut === true ||
      (typeof r.level === 'string' && r.level.toLowerCase() === 'block'))
  );
}

/** Aggregate exceptions per `feature`. Pure; the whole catalog is derived from this. */
export function aggregateExceptions(rows: ExceptionRow[]): Map<string, FeatureAggregate> {
  const map = new Map<string, FeatureAggregate>();
  for (const r of rows) {
    let agg = map.get(r.feature);
    if (!agg) {
      agg = {
        feature: r.feature,
        open: 0,
        cleared: 0,
        rejected: 0,
        exposureCents: 0,
        escalate: 0,
        byDisposition: emptyDispositions(),
      };
      map.set(r.feature, agg);
    }
    if (r.status === OPEN_STATUS) {
      agg.open += 1;
      agg.exposureCents += Math.max(0, Math.round(r.amountAtRiskCents ?? 0));
      if (r.disposition) agg.byDisposition[r.disposition] += 1;
      if (isCriticalOpen(r)) agg.escalate += 1;
    } else if (r.status === 'APPROVED') {
      agg.cleared += 1;
    } else if (r.status === 'REJECTED') {
      agg.rejected += 1;
    }
  }
  return map;
}

/** Derive a control's status from its open/escalate counts. */
export function statusFromException(agg: FeatureAggregate | undefined): ControlStatus {
  if (!agg || agg.open === 0) return 'pass';
  return agg.escalate > 0 ? 'fail' : 'warn';
}

// ─────────────────────────────────────────────────────────────────────────────
// The control catalog — maps a governed feature to a SOX/COSO-framed control
// ─────────────────────────────────────────────────────────────────────────────

export interface ControlMeta {
  id: string; // e.g. 'EC-1'
  feature: string; // ai_decisions.feature key (or a synthetic key)
  name: string;
  category: string;
  framework: string; // COSO component + plain description
  drillHref: string;
}

/** EC numbering + framing for the exception-library controls (canon §5). Anything not
 *  listed falls back to the autonomy-catalog label with a generic control frame. */
const EC_META: Record<string, { id: string; category: string; framework: string }> = {
  DUPLICATE_PAYMENT: { id: 'EC-1', category: 'Accounts Payable', framework: 'COSO Control Activities · Duplicate-payment & vendor-master integrity' },
  MISSED_ACCRUAL: { id: 'EC-2', category: 'Close', framework: 'COSO Control Activities · Accrual completeness (cutoff)' },
  INTERCOMPANY_IMBALANCE: { id: 'EC-3', category: 'Consolidation', framework: 'COSO Control Activities · Intercompany balancing' },
  UNCATEGORIZED_LEAKAGE: { id: 'EC-4', category: 'General Ledger', framework: 'COSO Control Activities · Suspense / uncategorized leakage' },
  REVENUE_NOT_RECOGNIZED: { id: 'EC-6', category: 'Revenue', framework: 'COSO Control Activities · Revenue recognition (ASC 606)' },
  SALES_TAX_NEXUS: { id: 'EC-7', category: 'Tax', framework: 'COSO Control Activities · Sales-tax nexus monitoring' },
  ANOMALOUS_JE: { id: 'EC-10', category: 'General Ledger', framework: 'COSO Control Activities · Anomalous journal-entry detection' },
  CUTOFF_ERROR: { id: 'EC-12', category: 'Close', framework: 'COSO Control Activities · Period-cutoff accuracy' },
  BILL_ANOMALY: { id: 'AP-A', category: 'Accounts Payable', framework: 'COSO Control Activities · Bill anomaly vs vendor pattern' },
  PAYMENT_FRAUD: { id: 'PF-1', category: 'Money Movement', framework: 'COSO Control Activities · Payment-run fraud screen (BEC / new-payee)' },
};

/** Payment fraud is a control but lives outside the autonomy catalog — add it here. */
const EXTRA_CONTROL_LABELS: Record<string, string> = {
  PAYMENT_FRAUD: 'Payment-run fraud screen',
};

/** The exception-library controls, in a stable display order. */
export function controlCatalog(): ControlMeta[] {
  const controlFeatures = AUTONOMY_FEATURES.filter((f) => f.category === 'control').map((f) => f.feature);
  // PAYMENT_FRAUD is a real control feature not in the autonomy catalog.
  const features = [...controlFeatures, 'PAYMENT_FRAUD'];
  return features.map((feature) => {
    const meta = EC_META[feature];
    const label = AUTONOMY_FEATURE_MAP[feature]?.label ?? EXTRA_CONTROL_LABELS[feature] ?? feature;
    return {
      id: meta?.id ?? feature,
      feature,
      name: label,
      category: meta?.category ?? 'Controls',
      framework: meta?.framework ?? 'COSO Control Activities · Continuous financial control',
      drillHref: EXCEPTIONS_HREF,
    };
  });
}

export interface ControlCard extends ControlMeta {
  status: ControlStatus;
  openCount: number;
  clearedCount: number;
  escalateCount: number;
  exposureCents: number;
  detail: string;
}

function fmtCount(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/** Build the exception-driven control cards from the aggregate. Pure. */
export function buildControlCards(agg: Map<string, FeatureAggregate>): ControlCard[] {
  return controlCatalog().map((meta) => {
    const a = agg.get(meta.feature);
    const status = statusFromException(a);
    const open = a?.open ?? 0;
    const cleared = a?.cleared ?? 0;
    const escalate = a?.escalate ?? 0;
    const exposure = a?.exposureCents ?? 0;
    const detail =
      open === 0
        ? cleared > 0
          ? `No open exceptions · ${fmtCount(cleared, 'cleared')} historically — control operating.`
          : 'No exceptions detected — control active and monitoring.'
        : `${fmtCount(open, 'open exception')}${escalate > 0 ? ` (${escalate} escalated)` : ''} · ${fmtCount(cleared, 'cleared')}.`;
    return {
      ...meta,
      status,
      openCount: open,
      clearedCount: cleared,
      escalateCount: escalate,
      exposureCents: exposure,
      detail,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Segregation of duties (SoD) — money-movement approvals (pure)
// ─────────────────────────────────────────────────────────────────────────────

export type SodViolationType = 'APPROVER_EQ_PREPARER' | 'RELEASER_EQ_PREPARER';

export interface SodViolation {
  approvalId: string;
  kind: string;
  amountCents: number | null;
  type: SodViolationType;
  detail: string;
}

export interface SodEvidence {
  status: ControlStatus;
  /** approvals evaluated (all money movements in scope). */
  evaluated: number;
  /** approvals that reached an approver (approved_by set). */
  withApprover: number;
  /** approver present AND != preparer — positive dual-control evidence. */
  sodSatisfied: number;
  /** movements that reached a release (money actually moved). */
  released: number;
  violations: SodViolation[];
  byKind: Record<string, number>;
}

/**
 * Detect SoD violations across money-movement approvals + tally the positive
 * dual-control evidence. Pure.
 *
 *  - APPROVER_EQ_PREPARER: the same person prepared AND approved (the DB CHECK should
 *    make this impossible — surfacing it here catches any bypass / legacy row). fail.
 *  - RELEASER_EQ_PREPARER: the person who prepared also released the money (weaker —
 *    a three-way separation is preferred for release). fail.
 *
 * Status: any violation → fail; else if money movements exist but NONE has completed
 * dual control (no approver yet) → warn (no positive evidence to rely on); else pass.
 */
export function detectSodViolations(rows: ApprovalRow[]): SodEvidence {
  const violations: SodViolation[] = [];
  const byKind: Record<string, number> = {};
  let withApprover = 0;
  let sodSatisfied = 0;
  let released = 0;

  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.approvedBy) {
      withApprover += 1;
      if (r.approvedBy === r.preparedBy) {
        violations.push({
          approvalId: r.id,
          kind: r.kind,
          amountCents: r.amountCents,
          type: 'APPROVER_EQ_PREPARER',
          detail: 'Same user prepared and approved this money movement — segregation of duties breached.',
        });
      } else {
        sodSatisfied += 1;
      }
    }
    if (r.releasedBy) {
      released += 1;
      if (r.releasedBy === r.preparedBy) {
        violations.push({
          approvalId: r.id,
          kind: r.kind,
          amountCents: r.amountCents,
          type: 'RELEASER_EQ_PREPARER',
          detail: 'The preparer also released the funds — the release step was not independently separated.',
        });
      }
    }
  }

  let status: ControlStatus = 'pass';
  if (violations.length > 0) status = 'fail';
  else if (rows.length > 0 && withApprover === 0) status = 'warn';

  return {
    status,
    evaluated: rows.length,
    withApprover,
    sodSatisfied,
    released,
    violations,
    byKind,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Autonomy posture — AI supervision / SoD-on-the-AI (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface AutonomyPostureItem {
  feature: string;
  label: string;
  category: 'processing' | 'control';
  mode: AutonomyMode;
  materialityLimitCents: number | null;
  /** true when there is no explicit row — the conservative default dial applies. */
  isDefault: boolean;
}

export interface AutonomyPosture {
  status: ControlStatus;
  killSwitchEngaged: boolean;
  items: AutonomyPostureItem[];
  autoEnabledCount: number; // features dialed to AUTO_UNDER_LIMIT
  proposeCount: number;
  offCount: number;
}

/**
 * Cross-walk the autonomy catalog against the tenant's live dials. Every governed
 * capability appears exactly once; a capability with no row shows its conservative
 * default (PROPOSE) and isDefault=true. Pure.
 *
 * Status (canon §3 — conservative is the good state):
 *  - kill switch engaged → warn (autonomy globally halted — abnormal operating state).
 *  - any feature at AUTO_UNDER_LIMIT → warn (the machine may act; heightened supervision).
 *  - otherwise pass (all propose/off — human approves everything).
 */
export function buildAutonomyPosture(
  settings: LoadedAutonomySetting[],
  killSwitchEngaged: boolean,
): AutonomyPosture {
  const byFeature = new Map(settings.map((s) => [s.feature, s]));
  const items: AutonomyPostureItem[] = AUTONOMY_FEATURES.map((f) => {
    const row = byFeature.get(f.feature);
    return {
      feature: f.feature,
      label: f.label,
      category: f.category,
      mode: row?.mode ?? f.defaultMode,
      materialityLimitCents: row?.materialityLimitCents ?? null,
      isDefault: !row,
    };
  });

  const autoEnabledCount = items.filter((i) => i.mode === 'AUTO_UNDER_LIMIT').length;
  const proposeCount = items.filter((i) => i.mode === 'PROPOSE').length;
  const offCount = items.filter((i) => i.mode === 'OFF').length;

  const status: ControlStatus =
    killSwitchEngaged || autoEnabledCount > 0 ? 'warn' : 'pass';

  return { status, killSwitchEngaged, items, autoEnabledCount, proposeCount, offCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit-trail completeness (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditCompleteness {
  status: ControlStatus;
  totalActions: number;
  byActor: Record<ActorType, number>;
  lastActionAt: string | null;
}

/**
 * Score the audit trail. Canon: every action → the Decision Log. An empty trail is a
 * control gap (warn); a populated trail with machine-vs-human attribution is the good
 * state (pass). Pure.
 */
export function assessAuditCompleteness(rows: AuditActionRow[]): AuditCompleteness {
  const byActor: Record<ActorType, number> = { HUMAN: 0, AI: 0, SYSTEM: 0 };
  let lastActionAt: string | null = null;
  for (const r of rows) {
    if (byActor[r.actorType] !== undefined) byActor[r.actorType] += 1;
    if (r.createdAt && (!lastActionAt || r.createdAt > lastActionAt)) lastActionAt = r.createdAt;
  }
  const total = rows.length;
  const status: ControlStatus = total === 0 ? 'warn' : 'pass';
  return { status, totalActions: total, byActor, lastActionAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly — the full command-center payload (pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExceptionClassSummary {
  id: string;
  feature: string;
  name: string;
  category: string;
  status: ControlStatus;
  open: number;
  cleared: number;
  escalate: number;
  exposureCents: number;
}

export interface ComplianceSummary {
  totalControls: number;
  pass: number;
  warn: number;
  fail: number;
  openExceptions: number;
  totalExposureCents: number;
  /** synthesized worst-of across every control family (governance headline). */
  overall: ControlStatus;
}

export interface ComplianceCenter {
  generatedAt: string;
  summary: ComplianceSummary;
  controls: ControlCard[];
  exceptionsByClass: ExceptionClassSummary[];
  sod: SodEvidence;
  autonomy: AutonomyPosture;
  audit: AuditCompleteness;
  hrefs: { exceptions: string; audit: string; autonomy: string };
}

function worst(...statuses: ControlStatus[]): ControlStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

/** Assemble the full command center from already-loaded inputs. Pure & tested. */
export function assembleComplianceCenter(inputs: ComplianceInputs): ComplianceCenter {
  const agg = aggregateExceptions(inputs.exceptions);
  const controls = buildControlCards(agg);
  const sod = detectSodViolations(inputs.approvals);
  const autonomy = buildAutonomyPosture(inputs.autonomySettings, inputs.killSwitchEngaged);
  const audit = assessAuditCompleteness(inputs.auditActions);

  const exceptionsByClass: ExceptionClassSummary[] = controls.map((c) => ({
    id: c.id,
    feature: c.feature,
    name: c.name,
    category: c.category,
    status: c.status,
    open: c.openCount,
    cleared: c.clearedCount,
    escalate: c.escalateCount,
    exposureCents: c.exposureCents,
  }));

  const pass = controls.filter((c) => c.status === 'pass').length;
  const warn = controls.filter((c) => c.status === 'warn').length;
  const fail = controls.filter((c) => c.status === 'fail').length;
  const openExceptions = controls.reduce((s, c) => s + c.openCount, 0);
  const totalExposureCents = controls.reduce((s, c) => s + c.exposureCents, 0);

  const summary: ComplianceSummary = {
    totalControls: controls.length,
    pass,
    warn,
    fail,
    openExceptions,
    totalExposureCents,
    overall: worst(
      ...controls.map((c) => c.status),
      sod.status,
      autonomy.status,
      audit.status,
    ),
  };

  return {
    generatedAt: inputs.now ?? new Date().toISOString(),
    summary,
    controls,
    exceptionsByClass,
    sod,
    autonomy,
    audit,
    hrefs: { exceptions: EXCEPTIONS_HREF, audit: AUDIT_HREF, autonomy: AUTONOMY_HREF },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RLS-scoped loader (I/O). Degrades safe. Never throws on a best-effort source.
// ─────────────────────────────────────────────────────────────────────────────

const EXCEPTION_CAP = 5000;
const APPROVAL_CAP = 2000;
const AUDIT_CAP = 2000;

function num(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function asDisposition(raw: unknown): Disposition | null {
  return raw === 'AUTO' || raw === 'REVIEW' || raw === 'ESCALATE' || raw === 'BLOCKED'
    ? (raw as Disposition)
    : null;
}

function asMode(raw: unknown): AutonomyMode {
  return raw === 'OFF' || raw === 'PROPOSE' || raw === 'AUTO_UNDER_LIMIT'
    ? (raw as AutonomyMode)
    : 'PROPOSE';
}

interface RawAiRow {
  feature: string | null;
  status: string | null;
  confidence: number | string | null;
  proposed_output: Record<string, unknown> | null;
  created_at: string;
}
interface RawApprovalRow {
  id: string;
  kind: string | null;
  status: string | null;
  amount_cents: number | string | null;
  prepared_by: string | null;
  approved_by: string | null;
  released_by: string | null;
}
interface RawAuditRow {
  actor_type: ActorType | null;
  created_at: string;
}
interface RawSettingRow {
  feature: string | null;
  mode: string | null;
  materiality_limit_cents: number | string | null;
}

/**
 * Load + shape the compliance center for one org through the RLS-scoped client, so
 * the database enforces tenant isolation (this never filters org_id by hand for the
 * public/core RLS tables). Best-effort sources (autonomy tables that may not exist
 * pre-migration-075) degrade to the conservative reading rather than throwing.
 */
export async function loadComplianceCenter(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ComplianceCenter> {
  // ── Exception library (public.ai_decisions) ──────────────────────────────────
  const exceptions: ExceptionRow[] = [];
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('feature, status, confidence, proposed_output, created_at')
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED'])
      .order('created_at', { ascending: false })
      .limit(EXCEPTION_CAP);
    for (const r of (data ?? []) as RawAiRow[]) {
      const po = r.proposed_output ?? {};
      exceptions.push({
        feature: r.feature ?? 'UNKNOWN',
        status: r.status ?? '',
        confidence: num(r.confidence),
        amountAtRiskCents: num(po['amount_at_risk_cents']),
        disposition: asDisposition(po['disposition']),
        moneyAlreadyOut: po['money_already_out'] === true,
        level: typeof po['level'] === 'string' ? (po['level'] as string) : null,
        createdAt: r.created_at,
      });
    }
  } catch (e) {
    console.warn('[compliance-center] ai_decisions load failed:', e instanceof Error ? e.message : e);
  }

  // ── Money-movement SoD (public.approvals) ────────────────────────────────────
  const approvals: ApprovalRow[] = [];
  try {
    const { data } = await supabase
      .from('approvals')
      .select('id, kind, status, amount_cents, prepared_by, approved_by, released_by')
      .order('created_at', { ascending: false })
      .limit(APPROVAL_CAP);
    for (const r of (data ?? []) as RawApprovalRow[]) {
      approvals.push({
        id: r.id,
        kind: r.kind ?? 'UNKNOWN',
        status: r.status ?? '',
        amountCents: num(r.amount_cents),
        preparedBy: r.prepared_by ?? '',
        approvedBy: r.approved_by ?? null,
        releasedBy: r.released_by ?? null,
      });
    }
  } catch (e) {
    console.warn('[compliance-center] approvals load failed:', e instanceof Error ? e.message : e);
  }

  // ── Autonomy posture (autonomy_settings + autonomy_kill_switch) — degrade safe ─
  const autonomySettings: LoadedAutonomySetting[] = [];
  try {
    const { data } = await supabase
      .from('autonomy_settings')
      .select('feature, mode, materiality_limit_cents')
      .eq('org_id', orgId);
    for (const r of (data ?? []) as RawSettingRow[]) {
      if (!r.feature) continue;
      autonomySettings.push({
        feature: r.feature,
        mode: asMode(r.mode),
        materialityLimitCents: num(r.materiality_limit_cents),
      });
    }
  } catch {
    /* table may not exist yet → conservative defaults fill in via the shaper */
  }

  let killSwitchEngaged = false;
  try {
    const { data } = await supabase
      .from('autonomy_kill_switch')
      .select('engaged')
      .eq('org_id', orgId)
      .maybeSingle();
    killSwitchEngaged = ((data as { engaged?: boolean } | null)?.engaged ?? false) === true;
  } catch {
    killSwitchEngaged = false;
  }

  // ── Audit-trail completeness (core.action_log) ───────────────────────────────
  const auditActions: AuditActionRow[] = [];
  try {
    const { data } = await supabase
      .schema('core')
      .from('action_log')
      .select('actor_type, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(AUDIT_CAP);
    for (const r of (data ?? []) as RawAuditRow[]) {
      if (r.actor_type) auditActions.push({ actorType: r.actor_type, createdAt: r.created_at });
    }
  } catch (e) {
    console.warn('[compliance-center] action_log load failed:', e instanceof Error ? e.message : e);
  }

  return assembleComplianceCenter({
    exceptions,
    approvals,
    autonomySettings,
    killSwitchEngaged,
    auditActions,
  });
}
