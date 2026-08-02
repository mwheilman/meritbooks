/**
 * EC-10 — Anomalous / unsupported journal-entry detector (AU-C 240 flavor).
 *
 * A Financial Control Exception. Manual journal entries are the classic vehicle
 * for financial-statement fraud and error: they bypass the sub-ledgers, they are
 * hand-keyed, and — unlike an auto-posted engine entry (a bill, a payment, a
 * rev-rec release) — nothing upstream vouches for them. This control scans the
 * *posted manual JE population* and surfaces the ones an auditor would pull:
 * round-dollar, undocumented, oddly-timed, structured-just-under-a-threshold,
 * hitting a sensitive account, or posted by a preparer who never touches that
 * account. Each flagged entry becomes a PROPOSED `ai_decisions` row (feature
 * `ANOMALOUS_JE`) which the unified /exceptions queue already ingests as an
 * `ai_proposal` — no aggregator change, no schema change, no new table.
 *
 * Canon fidelity:
 *   - AI *proposes a fact* ("this JE looks unsupported, $X at risk") + drafts a
 *     remediation ("require a description + attachment + approver before it
 *     posts"). It NEVER writes a debit/credit, never fabricates support, never
 *     auto-applies. A human with the right role decides. (CANON §3.)
 *   - Auto-posted engine entries (source_module != MANUAL) are lower-risk and are
 *     NOT flagged — the manual population is the risk surface (task grounding).
 *   - Fail closed on ambiguity: when we cannot resolve preparer privilege, a
 *     sensitive-account manual JE is still surfaced (a false positive is a cheap
 *     dismissed queue item; a missed one reaches the close). (FPB §0.)
 *   - Money is bigint cents; $-at-risk is the entry total. RLS-scoped client only.
 *   - Idempotent on the gl_entry id: a re-scan updates nothing and never
 *     double-queues an entry that already has an open proposal.
 *
 * The heuristics + thresholds live in `DEFAULT_ANOMALY_CONFIG` and are tunable
 * per call; the scoring is pure and unit-tested (`assessJournalEntry`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type AutonomyGovernance,
} from '@/lib/autonomy/disposition';

export const ANOMALOUS_JE_FEATURE = 'ANOMALOUS_JE';

// ────────────────────────────────────────────────────────────────────────────
// PURE HEURISTIC ENGINE (no I/O — unit-testable)
// ────────────────────────────────────────────────────────────────────────────

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

export interface JeAccountRef {
  id: string;
  number: string | null;
  name: string;
  type: AccountType;
  subType: string;
  isControl: boolean;
}

/** Normalized facts for one posted manual journal entry. */
export interface JournalEntryFacts {
  entryId: string;
  entryNumber: string | null;
  sourceModule: string | null; // 'MANUAL' | null are the risk surface
  entryType: string; // 'STANDARD', 'ADJUSTING', ...
  entryDate: string; // 'YYYY-MM-DD'
  postedAt: string | null; // ISO timestamptz (UTC); falls back to createdAt
  createdAt: string; // ISO timestamptz
  memo: string | null;
  lineMemos: string[];
  /** entry total = sum of debit_cents (= sum of credit_cents on a balanced JE) */
  totalCents: number;
  isReversing: boolean; // this entry reverses a prior one (is_reversing)
  reversesEntry: boolean; // reversal_of_id present
  hasBeenReversed: boolean; // reversed_by_id present (this entry was later undone)
  accounts: JeAccountRef[]; // distinct accounts the entry touches
  /** who posted it (gl_entries.created_by uuid, or a sentinel when null) */
  preparerId: string;
  /** how many manual entries this preparer has in the scanned population */
  preparerEntryCount: number;
  /** per-account use-count for this preparer across the population (incl. this entry) */
  preparerAccountUsage: Record<string, number>;
  /** preparer is authorized to hand-post to sensitive accounts (equity/suspense/IC/reserves) */
  preparerIsPrivileged: boolean;
}

export interface AnomalyConfig {
  /** round-dollar only counts as a flag at/above this entry total (cents) */
  roundDollarThresholdCents: number;
  /** "round" = entry total divisible by this many cents (default $1,000) */
  roundDollarUnitCents: number;
  /** approval threshold entries may be structured just under (cents); null disables */
  approvalThresholdCents: number | null;
  /** just-under band = [pct * threshold, threshold). e.g. 0.9 → $9,000–$9,999.99 for $10k */
  justUnderBandPct: number;
  /** posted at/after this UTC hour is "after-hours" */
  afterHoursStartHour: number;
  /** posted before this UTC hour is "after-hours" */
  afterHoursEndHour: number;
  /** entry_date this many days before created_at ⇒ backdated */
  backdateLagDays: number;
  /** below this entry total, never ESCALATE (downgrade to REVIEW) */
  materialityCents: number;
  /** preparer needs at least this many entries before "unusual account" fires */
  newPreparerMinHistory: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  roundDollarThresholdCents: 500_000, // $5,000
  roundDollarUnitCents: 100_000, // $1,000
  approvalThresholdCents: 1_000_000, // $10,000
  justUnderBandPct: 0.9,
  afterHoursStartHour: 20, // 8pm UTC
  afterHoursEndHour: 6, // 6am UTC
  backdateLagDays: 5,
  materialityCents: 100_000, // $1,000
  newPreparerMinHistory: 20,
};

export type AnomalyFlagCode =
  | 'MISSING_SUPPORT'
  | 'ROUND_DOLLAR'
  | 'JUST_UNDER_THRESHOLD'
  | 'SENSITIVE_ACCOUNT'
  | 'UNUSUAL_ACCOUNT_FOR_PREPARER'
  | 'AFTER_HOURS_OR_WEEKEND'
  | 'BACKDATED'
  | 'PERIOD_END_TIMING'
  | 'REVERSAL_CHURN';

export interface AnomalyFlag {
  code: AnomalyFlagCode;
  label: string;
  detail: string;
  weight: number;
}

export interface AnomalyAssessment {
  entryId: string;
  /** 0..1 aggregate anomaly severity (clamped sum of fired flag weights) */
  score: number;
  /** 0..1 confidence the entry is *clean* (1 − score); fed to scoreToTier */
  confidence: number;
  tier: Tier;
  /** dollar total of the entry — the amount at risk of misstatement */
  amountAtRiskCents: number;
  flags: AnomalyFlag[];
  /** plain-language summary for the exception queue + audit trail */
  reason: string;
  tierReason: string;
}

// Per-heuristic severity weights. Tunable; documented above each.
const WEIGHTS: Record<AnomalyFlagCode, number> = {
  MISSING_SUPPORT: 0.35, // core AU-C 240 signal: an undocumented manual JE
  JUST_UNDER_THRESHOLD: 0.3, // structuring to dodge an approval gate
  SENSITIVE_ACCOUNT: 0.3, // equity/suspense/intercompany/reserve by non-privileged hand
  BACKDATED: 0.25, // entry_date well before it was actually keyed
  ROUND_DOLLAR: 0.2, // estimates/plugs skew round
  UNUSUAL_ACCOUNT_FOR_PREPARER: 0.2, // preparer touched an account they never use
  REVERSAL_CHURN: 0.2, // reverse-and-repost pattern
  AFTER_HOURS_OR_WEEKEND: 0.15, // off-hours posting (UTC approximation)
  PERIOD_END_TIMING: 0.1, // landed on the last days of the month
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const money = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

const SENSITIVE_NAME_RE =
  /suspense|clearing|ask my accountant|inter[-\s]?company|due (to|from)|reserve|allowance|provision|contra/i;

/** A manual JE has no support when neither the header memo nor any line memo carries text. */
function hasNoSupport(facts: JournalEntryFacts): boolean {
  const header = (facts.memo ?? '').trim();
  const lines = facts.lineMemos.map((m) => (m ?? '').trim()).filter(Boolean);
  return header.length === 0 && lines.length === 0;
}

/** Sensitive = equity, or a suspense/clearing/intercompany/reserve/allowance-named account, or a control account. */
export function isSensitiveAccount(a: JeAccountRef): boolean {
  if (a.type === 'EQUITY' || a.subType === 'EQUITY') return true;
  if (a.isControl) return true;
  return SENSITIVE_NAME_RE.test(a.name);
}

/**
 * Score one posted manual journal entry against every heuristic. Pure: same
 * facts + config ⇒ same assessment. Auto-posted (non-manual) entries score 0.
 */
export function assessJournalEntry(
  facts: JournalEntryFacts,
  policy: TierPolicy,
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): AnomalyAssessment {
  const flags: AnomalyFlag[] = [];
  const total = facts.totalCents;

  const manual = facts.sourceModule === null || facts.sourceModule.toUpperCase() === 'MANUAL';

  if (manual) {
    // 1. Missing description / support.
    if (hasNoSupport(facts)) {
      flags.push({
        code: 'MISSING_SUPPORT',
        label: 'No description or support',
        detail: 'Manual entry posted with no header memo and no line-level explanation.',
        weight: WEIGHTS.MISSING_SUPPORT,
      });
    }

    // 2. Round-dollar above threshold.
    if (
      total >= config.roundDollarThresholdCents &&
      config.roundDollarUnitCents > 0 &&
      total % config.roundDollarUnitCents === 0
    ) {
      flags.push({
        code: 'ROUND_DOLLAR',
        label: 'Round-dollar amount',
        detail: `Entry total ${money(total)} is an exact multiple of ${money(config.roundDollarUnitCents)} — typical of an estimate or plug.`,
        weight: WEIGHTS.ROUND_DOLLAR,
      });
    }

    // 3. Structured just under an approval threshold.
    if (config.approvalThresholdCents && config.approvalThresholdCents > 0) {
      const band = config.justUnderBandPct * config.approvalThresholdCents;
      if (total >= band && total < config.approvalThresholdCents) {
        flags.push({
          code: 'JUST_UNDER_THRESHOLD',
          label: 'Just under approval threshold',
          detail: `Entry total ${money(total)} sits just below the ${money(config.approvalThresholdCents)} approval threshold.`,
          weight: WEIGHTS.JUST_UNDER_THRESHOLD,
        });
      }
    }

    // 4. Sensitive account touched by a non-privileged preparer (fail closed when unknown).
    const sensitive = facts.accounts.filter(isSensitiveAccount);
    if (sensitive.length > 0 && !facts.preparerIsPrivileged) {
      const names = sensitive.map((a) => a.name).slice(0, 3).join(', ');
      flags.push({
        code: 'SENSITIVE_ACCOUNT',
        label: 'Sensitive account',
        detail: `Hand-posts to a sensitive account (${names}) by a preparer not marked authorized for it.`,
        weight: WEIGHTS.SENSITIVE_ACCOUNT,
      });
    }

    // 5. Unusual account for this preparer (only once the preparer has enough history).
    if (facts.preparerEntryCount >= config.newPreparerMinHistory) {
      const rare = facts.accounts.filter((a) => (facts.preparerAccountUsage[a.id] ?? 0) <= 1);
      if (rare.length > 0) {
        const names = rare.map((a) => a.name).slice(0, 3).join(', ');
        flags.push({
          code: 'UNUSUAL_ACCOUNT_FOR_PREPARER',
          label: 'Unusual account for preparer',
          detail: `Preparer rarely posts to ${names} (first or only use across ${facts.preparerEntryCount} of their entries).`,
          weight: WEIGHTS.UNUSUAL_ACCOUNT_FOR_PREPARER,
        });
      }
    }

    // 6. After-hours / weekend posting (UTC approximation).
    const stamp = facts.postedAt ?? facts.createdAt;
    const when = new Date(stamp);
    if (!Number.isNaN(when.getTime())) {
      const dow = when.getUTCDay(); // 0 = Sun, 6 = Sat
      const hour = when.getUTCHours();
      const weekend = dow === 0 || dow === 6;
      const offHours = hour >= config.afterHoursStartHour || hour < config.afterHoursEndHour;
      if (weekend || offHours) {
        const which = weekend ? 'on a weekend' : `at ${hour.toString().padStart(2, '0')}:00 UTC (off-hours)`;
        flags.push({
          code: 'AFTER_HOURS_OR_WEEKEND',
          label: 'Off-hours posting',
          detail: `Posted ${which}.`,
          weight: WEIGHTS.AFTER_HOURS_OR_WEEKEND,
        });
      }
    }

    // 7. Backdated: effective date well before it was actually keyed.
    const created = new Date(facts.createdAt);
    const effective = new Date(`${facts.entryDate}T00:00:00Z`);
    if (!Number.isNaN(created.getTime()) && !Number.isNaN(effective.getTime())) {
      const lagDays = (created.getTime() - effective.getTime()) / 86_400_000;
      if (lagDays > config.backdateLagDays) {
        flags.push({
          code: 'BACKDATED',
          label: 'Backdated entry',
          detail: `Effective date ${facts.entryDate} is ${Math.round(lagDays)} days before it was posted.`,
          weight: WEIGHTS.BACKDATED,
        });
      }
      // 8. Period-end timing: landed on the last two days of the month.
      const d = effective.getUTCDate();
      const lastDay = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth() + 1, 0)).getUTCDate();
      if (d >= lastDay - 1) {
        flags.push({
          code: 'PERIOD_END_TIMING',
          label: 'Period-end timing',
          detail: `Effective date ${facts.entryDate} falls on the last days of the period.`,
          weight: WEIGHTS.PERIOD_END_TIMING,
        });
      }
    }

    // 9. Reverse-and-repost churn.
    if (facts.isReversing || facts.reversesEntry || facts.hasBeenReversed) {
      flags.push({
        code: 'REVERSAL_CHURN',
        label: 'Reversal activity',
        detail: facts.hasBeenReversed
          ? 'This entry was later reversed — verify it was not re-posted to move a result between periods.'
          : 'This entry reverses a prior manual entry — verify the reversal-and-repost is legitimate.',
        weight: WEIGHTS.REVERSAL_CHURN,
      });
    }
  }

  const score = clamp01(flags.reduce((s, f) => s + f.weight, 0));
  const confidence = clamp01(1 - score);

  // Route via the shared tier engine. We deliberately DO NOT pass amount here:
  // scoreToTier's amount cap is a *downgrade auto→review* rule for autonomous
  // actions, which would wrongly queue every large but clean manual JE. Instead
  // we gate ESCALATE on $-materiality ourselves below (FPB: "ESCALATE above
  // materiality without support; REVIEW otherwise").
  const routed = scoreToTier({ confidence }, policy);
  let tier = routed.tier;
  if (tier === 'escalate' && total < config.materialityCents) tier = 'review';

  const reason = buildReason(facts, flags, total, tier);

  return {
    entryId: facts.entryId,
    score,
    confidence,
    tier,
    amountAtRiskCents: total,
    flags,
    reason,
    tierReason: routed.reason,
  };
}

function buildReason(
  facts: JournalEntryFacts,
  flags: AnomalyFlag[],
  total: number,
  tier: Tier,
): string {
  const num = facts.entryNumber ? `#${facts.entryNumber}` : 'entry';
  if (flags.length === 0) {
    return `Manual JE ${num} for ${money(total)} shows no anomaly signals.`;
  }
  const lead = tier === 'escalate' ? 'High-risk manual JE' : 'Manual JE to review';
  const signals = flags.map((f) => f.label.toLowerCase()).join('; ');
  return `${lead} ${num} — ${money(total)} at risk. Signals: ${signals}.`;
}

/** The drafted remediation the AI proposes (never auto-applied) for a flagged entry. */
export function draftRemediation(assessment: AnomalyAssessment): string {
  if (assessment.tier === 'escalate') {
    return 'Require a description, supporting document, and an approver (preparer ≠ approver) before this entry is trusted; if it cannot be supported, reverse it through the posting engine.';
  }
  return 'Attach a description and supporting evidence, and confirm the account coding is correct.';
}

// ────────────────────────────────────────────────────────────────────────────
// SCAN (I/O — RLS-scoped; writes PROPOSED ai_decisions; idempotent per gl_entry)
// ────────────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** only scan entries with entry_date >= this ('YYYY-MM-DD') */
  sinceDate?: string;
  /** cap the population loaded (default 1000, most recent by entry_date) */
  limit?: number;
  /** override the default heuristic config */
  config?: Partial<AnomalyConfig>;
}

export interface ScanResult {
  scanned: number; // manual entries assessed
  flagged: number; // entries with ≥1 anomaly signal at review/escalate tier
  queued: number; // NEW exception-queue items created (deduped on gl_entry id)
  escalated: number; // of the queued, how many are ESCALATE tier
}

interface GlEntryRow {
  id: string;
  entry_number: string | null;
  source_module: string | null;
  entry_type: string;
  entry_date: string;
  posted_at: string | null;
  created_at: string;
  memo: string | null;
  is_reversing: boolean | null;
  reversal_of_id: string | null;
  reversed_by_id: string | null;
  created_by: string | null;
}

interface GlLineRow {
  gl_entry_id: string;
  account_id: string;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  memo: string | null;
}

interface AccountRow {
  id: string;
  account_number: string | null;
  name: string;
  account_type: AccountType;
  account_sub_type: string;
  is_control_account: boolean | null;
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const UNKNOWN_PREPARER = 'UNKNOWN';

/**
 * Scan the org's posted manual JE population and queue anomalous entries into the
 * /exceptions pipeline. Never throws — a control that crashes the pass it rides
 * on is worse than one that reports zero. Idempotent: an entry that already has
 * an open PROPOSED ANOMALOUS_JE proposal is not queued again.
 */
export async function scanAnomalousJournalEntries(
  supabase: SupabaseClient,
  orgId: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, flagged: 0, queued: 0, escalated: 0 };
  const config: AnomalyConfig = { ...DEFAULT_ANOMALY_CONFIG, ...(opts.config ?? {}) };
  const limit = opts.limit ?? 1000;

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    return result;
  }

  // Autonomy Control Plane: kill-switch + per-feature dial, resolved once; the
  // ADVISORY disposition is recorded on each queued exception (detect-only).
  const gov: AutonomyGovernance = await loadAutonomyGovernance(
    supabase,
    orgId,
    ANOMALOUS_JE_FEATURE,
  );

  // 1. Load the posted MANUAL entry population (the risk surface).
  let entryQuery = supabase
    .from('gl_entries')
    .select(
      'id, entry_number, source_module, entry_type, entry_date, posted_at, created_at, memo, is_reversing, reversal_of_id, reversed_by_id, created_by',
    )
    .eq('status', 'POSTED')
    .eq('source_module', 'MANUAL')
    .order('entry_date', { ascending: false })
    .limit(limit);
  if (opts.sinceDate) entryQuery = entryQuery.gte('entry_date', opts.sinceDate);

  const { data: entryData, error: entryErr } = await entryQuery;
  if (entryErr) {
    console.warn('[controls/anomalous-je] entry load failed:', entryErr.message);
    return result;
  }
  const entries = (entryData ?? []) as GlEntryRow[];
  if (entries.length === 0) return result;

  // 2. Load their lines + the org's accounts (RLS-scoped).
  const entryIds = entries.map((e) => e.id);
  const [{ data: lineData, error: lineErr }, { data: acctData, error: acctErr }] = await Promise.all([
    supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, account_id, debit_cents, credit_cents, memo')
      .in('gl_entry_id', entryIds),
    supabase
      .from('accounts')
      .select('id, account_number, name, account_type, account_sub_type, is_control_account'),
  ]);
  if (lineErr || acctErr) {
    console.warn('[controls/anomalous-je] line/account load failed:', (lineErr ?? acctErr)?.message);
    return result;
  }
  const lines = (lineData ?? []) as GlLineRow[];
  const accounts = (acctData ?? []) as AccountRow[];

  const acctMap = new Map<string, JeAccountRef>();
  for (const a of accounts) {
    acctMap.set(a.id, {
      id: a.id,
      number: a.account_number,
      name: a.name,
      type: a.account_type,
      subType: a.account_sub_type,
      isControl: !!a.is_control_account,
    });
  }

  const linesByEntry = new Map<string, GlLineRow[]>();
  for (const l of lines) {
    const arr = linesByEntry.get(l.gl_entry_id) ?? [];
    arr.push(l);
    linesByEntry.set(l.gl_entry_id, arr);
  }

  // 3. Build per-preparer profiles across the loaded population:
  //    - entry count, and per-account use frequency (for the "unusual account" signal).
  const preparerEntryCount = new Map<string, number>();
  const preparerAccountUsage = new Map<string, Record<string, number>>();
  for (const e of entries) {
    const prep = e.created_by ?? UNKNOWN_PREPARER;
    preparerEntryCount.set(prep, (preparerEntryCount.get(prep) ?? 0) + 1);
    const usage = preparerAccountUsage.get(prep) ?? {};
    const distinct = new Set((linesByEntry.get(e.id) ?? []).map((l) => l.account_id));
    for (const aid of distinct) usage[aid] = (usage[aid] ?? 0) + 1;
    preparerAccountUsage.set(prep, usage);
  }

  // 4. Dedupe: which entries already have an open ANOMALOUS_JE proposal.
  const alreadyQueued = new Set<string>();
  try {
    const { data: open } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', ANOMALOUS_JE_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of open ?? []) {
      const po = (row as { proposed_output?: { gl_entry_id?: string } }).proposed_output;
      if (po?.gl_entry_id) alreadyQueued.add(po.gl_entry_id);
    }
  } catch {
    /* dedupe is best-effort; the insert below simply re-adds if this failed */
  }

  // 5. Assess + queue.
  for (const e of entries) {
    const entryLines = linesByEntry.get(e.id) ?? [];
    const totalCents = entryLines.reduce((s, l) => s + num(l.debit_cents), 0);
    const distinctAcctIds = [...new Set(entryLines.map((l) => l.account_id))];
    const acctRefs = distinctAcctIds
      .map((id) => acctMap.get(id))
      .filter((a): a is JeAccountRef => !!a);
    const prep = e.created_by ?? UNKNOWN_PREPARER;

    const facts: JournalEntryFacts = {
      entryId: e.id,
      entryNumber: e.entry_number,
      sourceModule: e.source_module,
      entryType: e.entry_type,
      entryDate: e.entry_date,
      postedAt: e.posted_at,
      createdAt: e.created_at,
      memo: e.memo,
      lineMemos: entryLines.map((l) => l.memo ?? ''),
      totalCents,
      isReversing: !!e.is_reversing,
      reversesEntry: !!e.reversal_of_id,
      hasBeenReversed: !!e.reversed_by_id,
      accounts: acctRefs,
      preparerId: prep,
      preparerEntryCount: preparerEntryCount.get(prep) ?? 0,
      preparerAccountUsage: preparerAccountUsage.get(prep) ?? {},
      // Fail closed: without a resolved identity→role mapping we do not assume
      // the preparer is authorized for sensitive accounts (task/FPB §0).
      preparerIsPrivileged: false,
    };

    const assessment = assessJournalEntry(facts, policy, config);
    result.scanned++;

    // Only surface review/escalate items that actually tripped a signal; clean or
    // sub-signal (auto) entries stay off the queue to avoid crying wolf.
    const surface = assessment.flags.length > 0 && (assessment.tier === 'review' || assessment.tier === 'escalate');
    if (!surface) continue;
    result.flagged++;

    if (alreadyQueued.has(e.id)) continue;

    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: assessment.tier,
      amountCents: assessment.amountAtRiskCents,
    });

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      feature: ANOMALOUS_JE_FEATURE,
      input_summary: assessment.reason,
      proposed_output: {
        gl_entry_id: e.id,
        entry_number: e.entry_number,
        amount_at_risk_cents: assessment.amountAtRiskCents,
        tier: assessment.tier,
        disposition,
        score: assessment.score,
        flags: assessment.flags,
        remediation: draftRemediation(assessment),
      },
      confidence: Number(assessment.confidence.toFixed(4)),
      reasoning: `${assessment.tierReason} Signals: ${assessment.flags.map((f) => f.detail).join(' ')}`,
      clarifying_question:
        'Add a description + supporting document and route for approval, or confirm this manual entry is legitimate?',
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/anomalous-je] could not queue exception:', error.message);
      continue;
    }
    alreadyQueued.add(e.id);
    result.queued++;
    if (assessment.tier === 'escalate') result.escalated++;

    // Trust audit trail — logged ONLY on a newly queued exception (after the dedup
    // skip), so re-scans don't append duplicate AI-attributed action_log rows.
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.anomalous_je.flag',
      subjectTable: 'gl_entries',
      subjectId: e.id,
      summary: assessment.reason,
      confidence: assessment.confidence,
      tier: assessment.tier,
      metadata: {
        entry_number: e.entry_number,
        amount_at_risk_cents: assessment.amountAtRiskCents,
        flags: assessment.flags.map((f) => f.code),
        score: assessment.score,
      },
    });
  }

  return result;
}
