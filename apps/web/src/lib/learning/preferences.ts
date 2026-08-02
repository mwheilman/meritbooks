/**
 * Generic org-scoped LEARNED-PREFERENCE / MEMORY store (Modality M14 — LEARNING /
 * PERSONALIZATION, generalized).
 *
 * The first learning primitive (`vendor-memory.ts`) taught MeritBooks ONE thing:
 * how a tenant codes a vendor. This module is the reusable substrate the WHOLE app
 * can read and write — a small typed key/value memory scoped per org, per `scope`
 * (a namespace like CATEGORIZATION / CLOSE_CADENCE / REPORT_PREFS / TONE / METHOD_SSP),
 * per `key`. Two shapes ride on top of one `public.learned_preferences` table:
 *
 *   1. DIRECT value  — `setPreference` / `getPreference` treat `value` as an opaque,
 *      caller-owned blob (a saved default the tenant explicitly chose).
 *   2. OBSERVATION learner — `recordObservation` / `getLearnedPreference` treat
 *      `value` as a frequency LEDGER: each observation tallies a sample; the store
 *      derives the WINNER (the tenant's typical choice) plus a confidence that grows
 *      with consistency AND sample size, capped below 1.0 — the same humble,
 *      recency-aware ranking `vendor-memory` uses.
 *
 * CANON ALIGNMENT (docs/canon/CANON-ANCHOR.md §3): learning INFORMS proposals; it
 * NEVER auto-acts. Everything here is READ-ONLY personalization — it defaults a
 * selector, pre-fills a hint, boosts a proposal's confidence. It never posts a
 * debit/credit, never approves, never mutates a ledger. A human still decides.
 *
 * DEGRADE-SAFE (the hard requirement): if the `learned_preferences` table is absent
 * (migration not yet applied), every read returns `null`/`[]` and every write returns
 * `false` — the app behaves exactly as it does today. Nothing throws.
 *
 * RLS + org scoping: every query runs on the caller's RLS-scoped client AND carries
 * an explicit `org_id` filter (defense in depth + correct upsert conflict target).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Namespace for a learned preference. Known scopes are named; open for growth. */
export type PreferenceScope =
  | 'CATEGORIZATION' // how a tenant codes X → Y (see vendor-memory for the live one)
  | 'CLOSE_CADENCE' // when/how the tenant runs their month-end close
  | 'REPORT_PREFS' // preferred period / comparative / basis per report
  | 'TONE' // preferred narrative voice for AI-written prose
  | 'METHOD_SSP' // preferred rev-rec method / standalone selling price defaults
  | (string & {});

/** A resolved preference the app consumes. */
export interface LearnedPreference<T = unknown> {
  scope: string;
  key: string;
  value: T;
  /** 0..1 — how sure we are this is the tenant's real preference. */
  confidence: number;
  /** How many observations informed it (1 for a directly-set preference). */
  observations: number;
  updatedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants (documented so behaviour is auditable, mirrors vendor-memory)
// ─────────────────────────────────────────────────────────────────────────────

/** Never claim total certainty — a human still decides. */
const MAX_PREF_CONFIDENCE = 0.97;
/** Observations needed before consistency counts at full strength. */
const FULL_CONFIDENCE_COUNT = 4;
/** Bound ledger growth: keep at most this many distinct observed values. */
const MAX_DISTINCT = 24;

// ─────────────────────────────────────────────────────────────────────────────
// Observation ledger — the frequency memory behind the learner (PURE)
// ─────────────────────────────────────────────────────────────────────────────

interface TallyEntry<T> {
  /** Stable hash of the sample, so equal choices collapse. */
  hash: string;
  value: T;
  count: number;
  /** ISO of the most recent time this value was observed (drives tie-breaks). */
  lastAt: string;
}

/** The `value` jsonb of an observation-learned preference. */
export interface ObservationLedger<T> {
  kind: 'observation-ledger';
  /** Total observations ever recorded (may exceed Σcount if distinct were capped). */
  total: number;
  tally: TallyEntry<T>[];
}

function isLedger(v: unknown): v is ObservationLedger<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'observation-ledger' &&
    Array.isArray((v as { tally?: unknown }).tally)
  );
}

/** An empty ledger — the starting point before any observation. */
export function emptyLedger<T>(): ObservationLedger<T> {
  return { kind: 'observation-ledger', total: 0, tally: [] };
}

/** Deterministic, key-order-independent JSON — so `{a,b}` hashes like `{b,a}`. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * PURE: fold one observation into a ledger. Recent observations refresh `lastAt`
 * (so a fresh choice wins ties over a stale majority — "corrections win"), and the
 * distinct-value list is capped to bound storage.
 */
export function tallyObservation<T>(
  prev: ObservationLedger<T>,
  sample: T,
  at: string,
): ObservationLedger<T> {
  const hash = stableStringify(sample);
  const tally = prev.tally.map((e) => ({ ...e }));
  const idx = tally.findIndex((e) => e.hash === hash);
  if (idx >= 0) {
    tally[idx].count += 1;
    tally[idx].lastAt = at;
    tally[idx].value = sample; // keep the freshest representation
  } else {
    tally.push({ hash, value: sample, count: 1, lastAt: at });
  }
  let capped = tally;
  if (tally.length > MAX_DISTINCT) {
    capped = [...tally]
      .sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt))
      .slice(0, MAX_DISTINCT);
  }
  return { kind: 'observation-ledger', total: prev.total + 1, tally: capped };
}

export interface ResolvedLedger<T> {
  /** The tenant's typical choice, or null when there is nothing to go on. */
  value: T | null;
  confidence: number;
  observations: number;
  /** Winner count / total — the raw consistency. */
  share: number;
}

/**
 * PURE: resolve a ledger into the winning value + a calibrated confidence.
 *
 * Winner = most-observed value, ties broken by recency. Confidence = consistency
 * (share) damped by sample size and capped below 1.0 — 9-of-10 is high-confidence,
 * 1-of-1 is not, exactly as the vendor-memory ranker treats its evidence.
 */
export function resolveLedger<T>(ledger: ObservationLedger<T>): ResolvedLedger<T> {
  const total = ledger.total;
  if (total === 0 || ledger.tally.length === 0) {
    return { value: null, confidence: 0, observations: 0, share: 0 };
  }
  const sorted = [...ledger.tally].sort(
    (a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt),
  );
  const top = sorted[0];
  const share = top.count / total;
  const sampleFactor = Math.min(1, total / FULL_CONFIDENCE_COUNT);
  const confidence = Math.min(MAX_PREF_CONFIDENCE, share * sampleFactor);
  return { value: top.value, confidence, observations: total, share };
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level row I/O — all degrade-safe (absent table ⇒ null/false, never throws)
// ─────────────────────────────────────────────────────────────────────────────

interface RawRow {
  scope: string;
  key: string;
  value: unknown;
  confidence: number | string | null;
  observations: number | null;
  updated_at: string | null;
}

const COLS = 'scope, key, value, confidence, observations, updated_at';

async function readRow(
  supabase: SupabaseClient,
  orgId: string,
  scope: string,
  key: string,
): Promise<RawRow | null> {
  try {
    const { data, error } = await supabase
      .from('learned_preferences')
      .select(COLS)
      .eq('org_id', orgId)
      .eq('scope', scope)
      .eq('key', key)
      .maybeSingle();
    if (error) return null;
    return (data as RawRow | null) ?? null;
  } catch {
    return null;
  }
}

async function upsertRow(
  supabase: SupabaseClient,
  orgId: string,
  scope: string,
  key: string,
  value: unknown,
  confidence: number,
  observations: number,
): Promise<boolean> {
  try {
    const { error } = await supabase.from('learned_preferences').upsert(
      {
        org_id: orgId,
        scope,
        key,
        value,
        confidence,
        observations,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,scope,key' },
    );
    return !error;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — direct value
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a preference's raw stored value. For observation-learned scopes this returns
 * the ledger blob — most callers want `getLearnedPreference` instead. Returns null
 * when absent or when the store is unavailable (degrade-safe).
 */
export async function getPreference<T = unknown>(
  supabase: SupabaseClient,
  orgId: string,
  scope: PreferenceScope,
  key: string,
): Promise<LearnedPreference<T> | null> {
  const row = await readRow(supabase, orgId, scope, key);
  if (!row) return null;
  return {
    scope: row.scope,
    key: row.key,
    value: row.value as T,
    confidence: Number(row.confidence) || 0,
    observations: row.observations ?? 0,
    updatedAt: row.updated_at,
  };
}

/**
 * Persist a directly-chosen preference (confidence defaults to 1 — the tenant said
 * so). Degrade-safe: returns false when the store is unavailable.
 */
export async function setPreference<T = unknown>(
  supabase: SupabaseClient,
  orgId: string,
  scope: PreferenceScope,
  key: string,
  value: T,
  opts?: { confidence?: number; observations?: number },
): Promise<boolean> {
  return upsertRow(
    supabase,
    orgId,
    scope,
    key,
    value,
    opts?.confidence ?? 1,
    opts?.observations ?? 1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — observation learner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record one observation of the tenant's behaviour and re-derive the learned winner.
 * This is the write half of the learner: fold `sample` into the ledger, resolve the
 * winner + confidence, and persist. Degrade-safe (no store ⇒ false, no throw).
 *
 * This only ever remembers what a human DID — it never acts on it.
 */
export async function recordObservation<T = unknown>(
  supabase: SupabaseClient,
  orgId: string,
  scope: PreferenceScope,
  key: string,
  sample: T,
  opts?: { at?: string },
): Promise<boolean> {
  const at = opts?.at ?? new Date().toISOString();
  const row = await readRow(supabase, orgId, scope, key);
  const prev: ObservationLedger<T> =
    row && isLedger(row.value) ? (row.value as ObservationLedger<T>) : emptyLedger<T>();
  const next = tallyObservation(prev, sample, at);
  const resolved = resolveLedger(next);
  return upsertRow(supabase, orgId, scope, key, next, resolved.confidence, resolved.observations);
}

/**
 * Read the learned winner for an observation scope: the tenant's typical choice plus
 * a calibrated confidence and the number of observations behind it. Returns null when
 * nothing has been learned yet OR the store is unavailable (degrade-safe) — so callers
 * fall back to their existing default with a single `if (!pref)`.
 */
export async function getLearnedPreference<T = unknown>(
  supabase: SupabaseClient,
  orgId: string,
  scope: PreferenceScope,
  key: string,
): Promise<LearnedPreference<T> | null> {
  const row = await readRow(supabase, orgId, scope, key);
  if (!row || !isLedger(row.value)) return null;
  const resolved = resolveLedger<T>(row.value as ObservationLedger<T>);
  if (resolved.value === null || resolved.observations === 0) return null;
  return {
    scope: row.scope,
    key: row.key,
    value: resolved.value,
    confidence: resolved.confidence,
    observations: resolved.observations,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — management (view / clear), for a settings surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List learned preferences (optionally filtered to one scope), each already resolved
 * to its winner + confidence, newest first. Degrade-safe: returns [] when unavailable.
 */
export async function listPreferences(
  supabase: SupabaseClient,
  orgId: string,
  scope?: PreferenceScope,
): Promise<LearnedPreference[]> {
  try {
    let q = supabase
      .from('learned_preferences')
      .select(COLS)
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (scope) q = q.eq('scope', scope);
    const { data, error } = await q;
    if (error || !data) return [];
    return (data as RawRow[]).map((r) => {
      if (isLedger(r.value)) {
        const res = resolveLedger(r.value as ObservationLedger<unknown>);
        return {
          scope: r.scope,
          key: r.key,
          value: res.value,
          confidence: res.confidence,
          observations: res.observations,
          updatedAt: r.updated_at,
        };
      }
      return {
        scope: r.scope,
        key: r.key,
        value: r.value,
        confidence: Number(r.confidence) || 0,
        observations: r.observations ?? 0,
        updatedAt: r.updated_at,
      };
    });
  } catch {
    return [];
  }
}

/** Forget one learned preference. Degrade-safe: returns false when unavailable. */
export async function clearPreference(
  supabase: SupabaseClient,
  orgId: string,
  scope: PreferenceScope,
  key: string,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('learned_preferences')
      .delete()
      .eq('org_id', orgId)
      .eq('scope', scope)
      .eq('key', key);
    return !error;
  } catch {
    return false;
  }
}
