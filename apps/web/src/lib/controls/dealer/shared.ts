/**
 * Dealer Pack control exceptions (FPB-dealer-pack §6, DL-1…DL-13) — shared types,
 * pure helpers and the ONE persistence path every dealer detector uses.
 *
 * Pattern (lib/controls/*): each detector is a PURE scorer (unit-tested) plus an
 * I/O collector that reads through the caller's RLS client. Findings become ONE
 * PROPOSED row each in public.ai_decisions (the /exceptions queue and the inbox
 * already fold PROPOSED ai_decisions in). Detect-only: nothing here posts, voids,
 * approves, releases or edits a dealer / GL / bill row — ai_decisions is the only
 * write. Idempotent: a stable dedup_key per finding (migration 070's partial unique
 * index on open rows is the DB guarantor); a finding a person already dispositioned
 * (APPROVED / REJECTED) is not resurfaced; an open finding whose condition has
 * cleared is EXPIRED (missed-accruals hygiene — e.g. paying off a sold-out-of-trust
 * note clears DL-1, AC 6).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { logAction } from '@/lib/trust/action-log';
import type { Tier } from '@/lib/trust/score-tier';
import { decideDisposition, loadAutonomyGovernance, type Disposition } from '@/lib/autonomy/disposition';
import { fetchAll } from '@/lib/supabase/fetch-all';
import type { DealerSettings } from '@/lib/dealer/types';

/** Stable feature codes (report to the lead for lib/autonomy/catalog.ts). */
export const DEALER_FEATURES = {
  SOT: 'DEALER_SOT',
  CURTAILMENT: 'DEALER_CURTAILMENT',
  FLOOR_MISMATCH: 'DEALER_FLOOR_MISMATCH',
  AGED_UNIT: 'DEALER_AGED_UNIT',
  WARRANTY: 'DEALER_WARRANTY',
  INCENTIVE: 'DEALER_INCENTIVE',
  STATEMENT_VARIANCE: 'DEALER_STATEMENT_VARIANCE',
  LINE_UTILIZATION: 'DEALER_LINE_UTILIZATION',
  TRADE_RISK: 'DEALER_TRADE_RISK',
  DEMO_ON_FLOOR: 'DEALER_DEMO_ON_FLOOR',
  DOUBLE_FLOORING: 'DEALER_DOUBLE_FLOORING',
} as const;
export type DealerFeature = (typeof DEALER_FEATURES)[keyof typeof DEALER_FEATURES];

export type DealerSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** One exception a detector wants on the queue (pre-persistence). */
export interface DealerFinding {
  /** FPB code, e.g. 'DL-1'. */
  control: string;
  /** Sub-kind within the detector, e.g. 'missed' / 'due'. */
  kind: string;
  /** Stable subject key — the same condition always yields the same key. */
  dedupKey: string;
  severity: DealerSeverity;
  amountAtRiskCents: number;
  /** Plain-English title (no codes, no role keys). */
  title: string;
  /** Plain-English explanation of why this fired. */
  reason: string;
  /** The plain-English next step. */
  question: string;
  /** Canonical drill URL (lib/dealer/ui/links.ts). */
  href: string;
  subjects: Record<string, string | null>;
  subjectTable: string;
  subjectId: string | null;
  facts?: Record<string, string | number | boolean | null>;
}

/** What a detector's collector gets for one client. */
export interface ClientScan {
  db: SupabaseClient;
  orgId: string;
  locationId: string;
  settings: DealerSettings;
  /** YYYY-MM-DD the scan evaluates "today" as. */
  asOf: string;
}

export interface DealerDetectorDef {
  key: string;
  feature: DealerFeature;
  /** FPB code(s) covered, e.g. 'DL-5/DL-6'. */
  control: string;
  label: string;
  collect: (c: ClientScan) => Promise<DealerFinding[]>;
}

export interface PersistSummary {
  detected: number;
  queued: number;
  refreshed: number;
  expired: number;
  /** Findings a person already dispositioned (not resurfaced). */
  suppressed: number;
  errors: number;
}

export const emptyPersist = (): PersistSummary => ({ detected: 0, queued: 0, refreshed: 0, expired: 0, suppressed: 0, errors: 0 });

// ── pure helpers ──────────────────────────────────────────────────────────────

/** CRITICAL / HIGH must reach a person as an escalation; MEDIUM / LOW are reviews. */
export function tierForSeverity(s: DealerSeverity): Tier {
  return s === 'CRITICAL' || s === 'HIGH' ? 'escalate' : 'review';
}

export function money(cents: number): string {
  return formatMoney(cents);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** 'YYYY-MM' of an ISO date — used where a condition may legitimately recur monthly. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Upper-case, alphanumerics only — for serial / invoice-number comparisons. */
export function normalizeToken(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Short subject label for a unit / note: serial when known, else the lender invoice #. */
export function subjectLabel(serial: string | null | undefined, lenderInvoice?: string | null): string {
  if (serial) return `serial ${serial}`;
  if (lenderInvoice) return `lender invoice ${lenderInvoice}`;
  return 'an unidentified unit';
}

export interface ExistingDecision {
  id: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  location_id: string | null;
  input_summary: string;
  confidence: number | null;
  dedupKey: string;
  amount: number | null;
  severity: string | null;
}

export interface PersistPlan {
  insert: DealerFinding[];
  refresh: Array<{ id: string; finding: DealerFinding }>;
  expire: string[];
  suppressed: number;
}

/**
 * Pure reconciliation of live findings against the queue for the clients that were
 * scanned successfully. Open rows whose key is no longer live are expired; a key a
 * person already resolved (APPROVED / REJECTED) with no open row is suppressed.
 */
export function planPersistence(
  live: Array<{ locationId: string; finding: DealerFinding }>,
  existing: ExistingDecision[],
  scannedLocationIds: ReadonlySet<string>,
): PersistPlan {
  const open = new Map<string, ExistingDecision>();
  const resolved = new Set<string>();
  for (const e of existing) {
    if (e.status === 'PROPOSED') open.set(e.dedupKey, e);
    else resolved.add(e.dedupKey);
  }
  const liveKeys = new Set<string>();
  const plan: PersistPlan = { insert: [], refresh: [], expire: [], suppressed: 0 };
  for (const { finding } of live) {
    if (liveKeys.has(finding.dedupKey)) continue; // one row per key
    liveKeys.add(finding.dedupKey);
    const prior = open.get(finding.dedupKey);
    if (prior) {
      const changed =
        prior.input_summary !== finding.title ||
        prior.amount !== finding.amountAtRiskCents ||
        prior.severity !== finding.severity;
      if (changed) plan.refresh.push({ id: prior.id, finding });
      continue;
    }
    if (resolved.has(finding.dedupKey)) {
      plan.suppressed += 1;
      continue;
    }
    plan.insert.push(finding);
  }
  for (const [key, row] of open) {
    if (liveKeys.has(key)) continue;
    if (!row.location_id || !scannedLocationIds.has(row.location_id)) continue;
    plan.expire.push(row.id);
  }
  return plan;
}

function proposedOutput(f: DealerFinding, tier: Tier, disposition: Disposition): Record<string, unknown> {
  return {
    control: f.control,
    kind: f.kind,
    dedup_key: f.dedupKey,
    amount_at_risk_cents: f.amountAtRiskCents,
    severity: f.severity,
    tier,
    disposition,
    subjects: f.subjects,
    href: f.href,
    reason: f.reason,
    ...(f.facts ? { facts: f.facts } : {}),
    detect_only: true,
  };
}

/** Deterministic detectors are certain about the FACT they report. */
const DETERMINISTIC_CONFIDENCE = 1;

/**
 * Write one detector's findings for the clients it scanned. Never throws — returns
 * counts with `errors` incremented instead.
 */
export async function persistDealerFindings(
  db: SupabaseClient,
  orgId: string,
  feature: DealerFeature,
  live: Array<{ locationId: string; finding: DealerFinding }>,
  scannedLocationIds: string[],
): Promise<PersistSummary> {
  const summary = emptyPersist();
  summary.detected = live.length;
  if (scannedLocationIds.length === 0) return summary;

  const existingRes = await fetchAll<Record<string, unknown>>(
    () =>
      db
        .from('ai_decisions')
        .select('id, status, location_id, input_summary, confidence, proposed_output')
        .eq('org_id', orgId)
        .eq('feature', feature)
        .in('status', ['PROPOSED', 'APPROVED', 'REJECTED'])
        .in('location_id', scannedLocationIds),
    { label: `dealer controls ${feature} queue` },
  ).catch((e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : String(e) } }));
  if (existingRes.error) {
    // Without the queue we can't dedupe or expire safely — do nothing (fail closed).
    console.warn(`[controls/dealer] ${feature} queue lookup failed:`, existingRes.error.message);
    summary.errors += 1;
    return summary;
  }
  const existing: ExistingDecision[] = [];
  for (const r of existingRes.data ?? []) {
    const po = (r.proposed_output ?? {}) as { dedup_key?: unknown; amount_at_risk_cents?: unknown; severity?: unknown };
    if (typeof po.dedup_key !== 'string') continue;
    existing.push({
      id: r.id as string,
      status: r.status as ExistingDecision['status'],
      location_id: (r.location_id as string | null) ?? null,
      input_summary: String(r.input_summary ?? ''),
      confidence: r.confidence == null ? null : Number(r.confidence),
      dedupKey: po.dedup_key,
      amount: po.amount_at_risk_cents == null ? null : Number(po.amount_at_risk_cents),
      severity: typeof po.severity === 'string' ? po.severity : null,
    });
  }

  const plan = planPersistence(live, existing, new Set(scannedLocationIds));
  summary.suppressed = plan.suppressed;
  const locationOf = new Map(live.map((l) => [l.finding.dedupKey, l.locationId]));

  const gov = await loadAutonomyGovernance(db, orgId, feature);
  const govern = (f: DealerFinding) => {
    const tier = tierForSeverity(f.severity);
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: tier,
      amountCents: f.amountAtRiskCents,
    });
    return { tier, disposition };
  };

  for (const { id, finding } of plan.refresh) {
    const { tier, disposition } = govern(finding);
    const { error } = await db
      .from('ai_decisions')
      .update({
        input_summary: finding.title,
        proposed_output: proposedOutput(finding, tier, disposition),
        confidence: DETERMINISTIC_CONFIDENCE,
        reasoning: finding.reason,
        clarifying_question: finding.question,
      })
      .eq('id', id)
      .eq('status', 'PROPOSED');
    if (error) {
      console.warn(`[controls/dealer] ${feature} refresh failed:`, error.message);
      summary.errors += 1;
    } else summary.refreshed += 1;
  }

  for (const finding of plan.insert) {
    const { tier, disposition } = govern(finding);
    const locationId = locationOf.get(finding.dedupKey) ?? null;
    const { error } = await db.from('ai_decisions').insert({
      org_id: orgId,
      location_id: locationId,
      feature,
      input_summary: finding.title,
      proposed_output: proposedOutput(finding, tier, disposition),
      confidence: DETERMINISTIC_CONFIDENCE,
      reasoning: finding.reason,
      clarifying_question: finding.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      // A concurrent scan may have won migration 070's unique index — counted, not fatal.
      console.warn(`[controls/dealer] ${feature} could not queue exception:`, error.message);
      summary.errors += 1;
      continue;
    }
    summary.queued += 1;
    try {
      await logAction(db, {
        orgId,
        actorType: 'AI',
        actorUserId: null,
        action: `controls.${feature.toLowerCase()}.detect`,
        subjectTable: finding.subjectTable,
        subjectId: finding.subjectId,
        summary: finding.title,
        locationId,
        confidence: DETERMINISTIC_CONFIDENCE,
        tier,
        metadata: {
          control: finding.control,
          kind: finding.kind,
          dedup_key: finding.dedupKey,
          amount_at_risk_cents: finding.amountAtRiskCents,
          severity: finding.severity,
          disposition,
        },
      });
    } catch {
      /* the trail is best-effort; the exception row is the record */
    }
  }

  if (plan.expire.length > 0) {
    const now = new Date().toISOString();
    for (const id of plan.expire) {
      const { error } = await db
        .from('ai_decisions')
        .update({
          status: 'EXPIRED',
          disposition_at: now,
          disposition_note: 'The condition has cleared — closed automatically by the dealer checks.',
        })
        .eq('id', id)
        .eq('status', 'PROPOSED');
      if (error) summary.errors += 1;
      else summary.expired += 1;
    }
  }
  return summary;
}

/** Vendor display names (core schema — stitched in JS). Best-effort. */
export async function vendorNames(db: SupabaseClient, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  try {
    for (let i = 0; i < unique.length; i += 200) {
      const { data } = await db
        .schema('core')
        .from('vendors')
        .select('id, name, display_name')
        .in('id', unique.slice(i, i + 200));
      for (const v of (data ?? []) as Array<{ id: string; name: string; display_name: string | null }>) {
        out.set(v.id, v.display_name || v.name);
      }
    }
  } catch {
    /* fall back to generic wording */
  }
  return out;
}

/** Throw a readable error for a failed read (caught per client by the runner). */
export function readFail(what: string, error: { message: string } | null | undefined): never {
  throw new Error(`${what}: ${error?.message ?? 'unknown error'}`);
}
