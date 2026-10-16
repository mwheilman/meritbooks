/**
 * Onboarding conversion — server-side session helpers.
 *
 * A conversion session is staged as a `public.ai_decisions` row (feature
 * CONVERSION_MAP, kind ONBOARDING_CONVERSION): its `proposed_output` JSON holds the
 * uploaded source lines, the proposed/edited mapping, and the assembled opening
 * trial balance. This REUSES the existing AI-decision staging table — no new
 * migration this wave — and inherits its RLS (org isolation) and audit fields.
 * On go-live the row flips to APPROVED and links to the opening GL entry it posted.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONVERSION_FEATURE,
  CONVERSION_KIND,
  extendedTieOutBlockers,
  hardClosedPeriodMessage,
  isIsoDate,
  takeoverDate,
  type ConversionSessionData,
  type TargetAccount,
} from './conversion';
import { buildGateSubledgerTies } from './reconciliation/build';
import type { SubledgerControlTie } from './reconciliation/tie-out';
import { generateYear, preGoLiveStatus, type PeriodStatus } from '@/lib/services/fiscal-periods';
import { sampleSessionPostBlock } from './sample-guard';

export interface ConversionSessionRow {
  id: string;
  status: string;
  data: ConversionSessionData;
  postedGlEntryId: string | null;
  createdAt: string;
}

/** All active tenant accounts as mapping targets (number + name). */
export async function loadTargetAccounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<TargetAccount[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('account_number, name, account_type')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('account_number');
  if (error) throw new Error(`Could not load the chart of accounts: ${error.message}`);
  return (data ?? []).map((a) => ({
    accountNumber: String((a as { account_number: string }).account_number),
    name: String((a as { name: string }).name),
    accountType: (a as { account_type: string | null }).account_type ?? null,
  }));
}

/** Map of active account number -> id, for resolving opening lines to accounts. */
export async function loadAccountIdByNumber(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, account_number')
    .eq('org_id', orgId)
    .eq('is_active', true);
  if (error) throw new Error(`Could not load accounts: ${error.message}`);
  return new Map(
    (data ?? []).map((a) => [
      String((a as { account_number: string }).account_number),
      String((a as { id: string }).id),
    ]),
  );
}

/** Load one conversion session, RLS-scoped. Returns null when not found. */
export async function loadSession(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<ConversionSessionRow | null> {
  const { data, error } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output, posted_gl_entry_id, created_at, feature')
    .eq('org_id', orgId)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    status: string;
    proposed_output: unknown;
    posted_gl_entry_id: string | null;
    created_at: string;
    feature: string;
  };
  const parsed = row.proposed_output as ConversionSessionData | null;
  if (!parsed || parsed.kind !== CONVERSION_KIND) return null;
  return {
    id: row.id,
    status: row.status,
    data: parsed,
    postedGlEntryId: row.posted_gl_entry_id,
    createdAt: row.created_at,
  };
}

/** List conversion sessions for the org (most recent first). */
export async function listSessions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Array<{ id: string; status: string; companyShortCode: string; asOfDate: string; balanced: boolean; tiedOut: boolean; posted: boolean; createdAt: string }>> {
  const { data } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output, posted_gl_entry_id, created_at')
    .eq('org_id', orgId)
    .eq('feature', CONVERSION_FEATURE)
    .order('created_at', { ascending: false })
    .limit(50);
  const out: Array<{ id: string; status: string; companyShortCode: string; asOfDate: string; balanced: boolean; tiedOut: boolean; posted: boolean; createdAt: string }> = [];
  for (const r of (data ?? []) as Array<{ id: string; status: string; proposed_output: ConversionSessionData | null; posted_gl_entry_id: string | null; created_at: string }>) {
    const d = r.proposed_output;
    if (!d || d.kind !== CONVERSION_KIND) continue;
    out.push({
      id: r.id,
      status: r.status,
      companyShortCode: d.companyShortCode,
      asOfDate: d.asOfDate,
      balanced: d.balance.balanced,
      tiedOut: d.tiedOut,
      posted: !!r.posted_gl_entry_id,
      createdAt: r.created_at,
    });
  }
  return out;
}

/** Persist an updated session data blob back onto its ai_decisions row. */
export async function saveSessionData(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
  data: ConversionSessionData,
): Promise<void> {
  const { error } = await supabase
    .from('ai_decisions')
    .update({ proposed_output: data })
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) throw new Error(`Could not save the conversion session: ${error.message}`);
}

/** Deterministic source_ref for the opening entry — the double-post guard. */
export function openingSourceRef(sessionId: string): string {
  return `CONVERSION-${sessionId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ONE gate predicate (FPB B8). The review screen (GET), the tie-out (PATCH)
// and go-live (POST …/post) all call this, so the screen can never show fewer
// blockers than the post route enforces.
// ─────────────────────────────────────────────────────────────────────────────

export interface GateBlockers {
  /** Every reason go-live is blocked (base TB + subledger→control ties), in dollars. */
  blockers: string[];
  /** The subledger→control ties checked (empty for a TB-only conversion). */
  subledgerTies: SubledgerControlTie[];
}

export async function computeGateBlockers(
  supabase: SupabaseClient,
  orgId: string,
  data: ConversionSessionData,
): Promise<GateBlockers> {
  const subledgerTies = await buildGateSubledgerTies(supabase, orgId, data);
  const blockers = extendedTieOutBlockers({
    openingBalances: data.openingBalances,
    balance: data.balance,
    balanceSheet: data.balanceSheet,
    unmapped: data.unmapped,
    unknownTargets: data.unknownTargets,
    sourceTotals: data.sourceTotals,
  }, subledgerTies, { plAcknowledged: data.plAcknowledged });
  // FPB B3 (never fake it): a session built from SAMPLE/fixture data can't go live in
  // production — shown here so the screen lists it before the confirm step.
  const sample = sampleSessionPostBlock(data, { orgId });
  if (sample) blockers.unshift(sample.error);
  return { blockers, subledgerTies };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cutover fiscal period (FPB B1) — the opening entry is dated the cutover date, so
// that month must exist and be postable for the company.
// ─────────────────────────────────────────────────────────────────────────────

export interface CutoverPeriod { id: string; status: PeriodStatus }

/** The fiscal period covering `date` for one company, or null when none exists. */
export async function findCutoverPeriod(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  date: string,
): Promise<CutoverPeriod | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .lte('start_date', date)
    .gte('end_date', date)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not look up the accounting month: ${error.message}`);
  return (data as CutoverPeriod | null) ?? null;
}

export type EnsureCutoverResult =
  | { ok: true; period: CutoverPeriod; created: number }
  | { ok: false; reason: 'HARD_CLOSE'; period: CutoverPeriod }
  | { ok: false; reason: 'MISSING' };

/**
 * Make sure the cutover month exists and is postable. When the company has no
 * periods for that year yet, the year is generated with the PRE-GO-LIVE statuses
 * (earlier months SOFT_CLOSE, never HARD_CLOSE). A HARD_CLOSE month is reported,
 * never silently reopened — reopening a locked month is a deliberate human act.
 */
export async function ensureCutoverPeriod(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  date: string,
): Promise<EnsureCutoverResult> {
  let period = await findCutoverPeriod(supabase, orgId, locationId, date);
  let created = 0;
  if (!period) {
    const year = Number(date.slice(0, 4));
    const res = await generateYear(supabase, orgId, locationId, year, { statusFor: preGoLiveStatus });
    created = res.created;
    period = await findCutoverPeriod(supabase, orgId, locationId, date);
  }
  if (!period) return { ok: false, reason: 'MISSING' };
  if (period.status === 'HARD_CLOSE') return { ok: false, reason: 'HARD_CLOSE', period };
  return { ok: true, period, created };
}

/** Company display name for messages (falls back to null; caller supplies a default). */
export async function loadCompanyName(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .schema('core').from('locations')
    .select('name')
    .eq('org_id', orgId)
    .eq('id', locationId)
    .maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The review-screen view of a session (GET / PATCH / batch mapping all return it).
// ─────────────────────────────────────────────────────────────────────────────

export interface CutoverNotice {
  /** 'ready' = month exists & postable; 'will_create' = generated at post; 'locked' = HARD_CLOSE. */
  state: 'ready' | 'will_create' | 'locked';
  message: string | null;
}

export type ConversionSessionView = ConversionSessionData & {
  id: string;
  status: string;
  posted: boolean;
  postedGlEntryId: string | null;
  companyName: string | null;
  takeoverDate: string | null;
  blockers: string[];
  subledgerTies: SubledgerControlTie[];
  cutover: CutoverNotice;
};

export async function buildSessionView(
  supabase: SupabaseClient,
  orgId: string,
  row: { id: string; status: string; postedGlEntryId: string | null },
  data: ConversionSessionData,
): Promise<ConversionSessionView> {
  const [{ blockers, subledgerTies }, companyName] = await Promise.all([
    computeGateBlockers(supabase, orgId, data),
    loadCompanyName(supabase, orgId, data.companyId),
  ]);

  // Read-only look at the cutover month so a locked month is flagged BEFORE the user
  // ticks "the numbers match", not as a surprise at post time.
  let cutover: CutoverNotice = { state: 'ready', message: null };
  if (!row.postedGlEntryId && isIsoDate(data.asOfDate)) {
    try {
      const period = await findCutoverPeriod(supabase, orgId, data.companyId, data.asOfDate);
      if (!period) {
        cutover = {
          state: 'will_create',
          message: `We'll set up ${data.asOfDate.slice(0, 4)}'s accounting months for this company automatically when you post.`,
        };
      } else if (period.status === 'HARD_CLOSE') {
        cutover = {
          state: 'locked',
          message: hardClosedPeriodMessage({ asOfDate: data.asOfDate, companyName: companyName ?? data.companyShortCode }),
        };
      }
    } catch {
      cutover = { state: 'ready', message: null }; // advisory only; the post route re-checks
    }
  }

  return {
    ...data,
    id: row.id,
    status: row.status,
    posted: !!row.postedGlEntryId,
    postedGlEntryId: row.postedGlEntryId,
    companyName,
    takeoverDate: isIsoDate(data.asOfDate) ? takeoverDate(data.asOfDate) : null,
    blockers,
    subledgerTies,
    cutover,
  };
}
