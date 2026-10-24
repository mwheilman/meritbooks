/**
 * Number governance for NON-ENGINE report routes (classic /api/reports/*, the trial balance,
 * period performance, the FP&A dashboard, board package, report packs, metrics). The engine
 * governs itself (./engine-adapter.ts); everything else that returns GL-derived figures runs
 * them through this guard first. Server-only.
 *
 *   const g = await governRoute(
 *     { supabase: ctx.supabase, orgId, userId: ctx.userId },
 *     { months: rangeMonths(startDate, endDate), locationIds },
 *   );
 *   if (g instanceof NextResponse) return g;           // 403 NOT_RELEASED (non-finance)
 *   return NextResponse.json({ ...body, governance: g.info });
 *
 * Rules (FPB §18):
 *   - The AUDIENCE is resolved server-side (finance = journal_entries:create OR
 *     close_mgmt:manage). No user (scheduled delivery) → non-finance (fail closed).
 *   - Finance (preview on — the default) passes through unchanged; `info` carries the
 *     watermark / banner / footnote so the figures can be labelled preview.
 *   - Non-finance: a (month × company) figure is returned only when that company's month
 *     is RELEASED. A combined figure for a month needs every included company released.
 *     Companies outside the caller's scope, or outside their in-group window (the classic
 *     routes do not window), deny the month — fail closed.
 *   - `cumulative` (balance sheet / trial balance / aging as of a date): the as-of month AND
 *     every earlier month with a fiscal period, back to the company's first fiscal period,
 *     must be released — otherwise a hidden month could be derived by subtracting two
 *     released balance sheets.
 *   - Ranges longer than MAX_GUARD_MONTHS are denied for non-finance (never partially
 *     checked).
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyGovernance, type GovernanceRequestContext } from './apply';
import { permissionProbe, resolveGovernanceAudience, ResolvedAudience, type CapabilityProbe } from './audience';
import { GovernanceDeniedError } from './filter';
import { loadGovernanceFacts } from './load';
import { addMonths, isPeriodKey, monthList, monthOf, periodKey } from './periods';
import type { CompanyPeriodDecision, GovernanceAudience, GovernanceDecision, GovernanceFacts, PeriodKey, ScopeKind, WatermarkMode } from './types';

/** The most months a guard decision covers (monthRange's cap). */
export const MAX_GUARD_MONTHS = 240;

type FactsLoader = (supabase: SupabaseClient, orgId: string, locationIds: readonly string[]) => Promise<GovernanceFacts>;

export interface RouteGuardDeps {
  probe?: CapabilityProbe;
  loadFacts?: FactsLoader;
  /** Every company id in the org (used when the request is unscoped = "all companies"). */
  listLocations?: (supabase: SupabaseClient, orgId: string) => Promise<string[]>;
}

export interface RouteGuardContext {
  /** The caller's RLS client — or, for scheduled delivery, the org-scoped service client. */
  supabase: SupabaseClient;
  orgId: string | null;
  /** null = no user (scheduled / emailed delivery) → non-finance. */
  userId: string | null;
  includePreview?: boolean;
  now?: Date;
  /** Reuse an audience already resolved in this request. */
  audience?: ResolvedAudience;
  deps?: RouteGuardDeps;
}

export interface RouteGuardRequest {
  /** Months the figures cover ('YYYY-MM'). For a cumulative view, its as-of month(s). */
  months: readonly PeriodKey[];
  /** Companies the figures cover; empty = every company in the org. */
  locationIds: readonly string[];
  scopeKind?: ScopeKind;
  /** Point-in-time (balance) figures: gate every month back to the first fiscal period. */
  cumulative?: boolean;
}

/** What a governed response may carry about the decision (never any figure). */
export interface GovernanceInfo {
  audience: GovernanceAudience;
  watermark: WatermarkMode;
  banner: { tone: 'warn'; text: string } | null;
  footnote: string;
  releasedThrough: PeriodKey | null;
  closedThrough: PeriodKey | null;
  /** Requested months that were withheld (dropped) from this response. */
  withheldPeriods: PeriodKey[];
}

export interface RouteGovernance {
  audience: GovernanceAudience;
  finance: boolean;
  /** The display decision over the requested months. */
  decision: GovernanceDecision;
  locationIds: string[];
  months: PeriodKey[];
  shownMonths: PeriodKey[];
  deniedMonths: PeriodKey[];
  /** May figures for this month (every company, or one company) be returned? */
  isShown(month: PeriodKey, locationId?: string): boolean;
  /** Throws GovernanceDeniedError unless every requested month is shown. */
  assertAllShown(): void;
  /** Keep only the rows whose month is shown. */
  keepShown<T>(rows: readonly T[], monthOfRow: (row: T) => PeriodKey | null): T[];
  info: GovernanceInfo;
}

// ── month helpers ───────────────────────────────────────────────────────────────

/** Months spanned by an ISO date range (inclusive), or null when longer than the cap. */
export function rangeMonths(startDate: string, endDate: string): PeriodKey[] | null {
  const from = monthOf(startDate);
  const to = monthOf(endDate);
  if (!isPeriodKey(from) || !isPeriodKey(to)) return null;
  if (from > to) return [];
  const out: PeriodKey[] = [];
  for (let k = from; k <= to; k = addMonths(k, 1)) {
    if (out.length >= MAX_GUARD_MONTHS) return null;
    out.push(k);
  }
  return out;
}

function firstPeriodOf(facts: GovernanceFacts, ids: readonly string[]): PeriodKey | null {
  let out: PeriodKey | null = null;
  for (const id of ids) {
    for (const p of facts.companies[id]?.periods ?? []) {
      const k = periodKey(p.year, p.month);
      if (out === null || k < out) out = k;
    }
  }
  return out;
}

function historyOf(first: PeriodKey | null, end: PeriodKey): PeriodKey[] {
  const floor = addMonths(end, -(MAX_GUARD_MONTHS - 1));
  const from = first && first < end ? (first < floor ? floor : first) : end;
  const out: PeriodKey[] = [];
  for (let k = from; k <= end; k = addMonths(k, 1)) out.push(k);
  return out;
}

// ── defaults ────────────────────────────────────────────────────────────────────

export const NO_USER_PROBE: CapabilityProbe = { has: async () => false };

async function listOrgLocations(supabase: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await supabase.schema('core').from('locations').select('id').eq('org_id', orgId);
  if (error) throw new Error(`Could not read companies: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * A facts loader that reads once per (org, companies) — pass the same one (deps.loadFacts)
 * to several guards in one request.
 */
export function memoFactsLoader(load: FactsLoader = loadGovernanceFacts): FactsLoader {
  return memo(load);
}

function memo(load: FactsLoader): FactsLoader {
  const cache = new Map<string, Promise<GovernanceFacts>>();
  return (supabase, orgId, ids) => {
    const key = `${orgId}|${[...ids].sort().join(',')}`;
    let p = cache.get(key);
    if (!p) {
      p = load(supabase, orgId, ids);
      cache.set(key, p);
    }
    return p;
  };
}

/** Resolve the caller's audience once (reusable across several guards in one request). */
export async function resolveRouteAudience(ctx: Pick<RouteGuardContext, 'userId' | 'audience' | 'deps'>): Promise<ResolvedAudience> {
  if (ctx.audience instanceof ResolvedAudience) return ctx.audience;
  const probe = ctx.deps?.probe ?? (ctx.userId ? permissionProbe(ctx.userId) : NO_USER_PROBE);
  return resolveGovernanceAudience(probe);
}

// ── the guard ───────────────────────────────────────────────────────────────────

function cellIndex(d: GovernanceDecision): Map<PeriodKey, Map<string, CompanyPeriodDecision>> {
  const out = new Map<PeriodKey, Map<string, CompanyPeriodDecision>>();
  for (const p of d.periods) out.set(p.key, new Map(p.companies.map((c) => [c.locationId, c])));
  return out;
}

function deniedAll(audience: GovernanceAudience, months: PeriodKey[], ids: string[], reason: string): RouteGovernance {
  const decision: GovernanceDecision = {
    audience,
    includePreview: false,
    proForma: false,
    periods: [],
    shownPeriodKeys: [],
    locationsByPeriod: {},
    outOfScopeLocationIds: [],
    closedThrough: { scope: null, byCompany: {} },
    releasedThrough: { scope: null, byCompany: {} },
    watermark: 'none',
    banner: null,
    annotations: [],
    footnote: reason,
  };
  return build(audience, decision, months, ids, () => false);
}

function build(
  audience: GovernanceAudience,
  decision: GovernanceDecision,
  months: PeriodKey[],
  ids: string[],
  shown: (month: PeriodKey, locationId?: string) => boolean,
): RouteGovernance {
  const shownMonths = months.filter((m) => shown(m));
  const deniedMonths = months.filter((m) => !shown(m));
  const info: GovernanceInfo = {
    audience,
    watermark: decision.watermark,
    banner: decision.banner,
    footnote: decision.footnote,
    releasedThrough: decision.releasedThrough.scope,
    closedThrough: decision.closedThrough.scope,
    withheldPeriods: deniedMonths,
  };
  return {
    audience,
    finance: audience === 'finance',
    decision,
    locationIds: ids,
    months,
    shownMonths,
    deniedMonths,
    isShown: shown,
    assertAllShown() {
      if (deniedMonths.length === 0) return;
      const head = deniedMonths.slice(0, 6);
      throw new GovernanceDeniedError(
        `${monthList(head)}${deniedMonths.length > 6 ? ' and more' : ''} ${deniedMonths.length === 1 ? 'is' : 'are'} not released for your audience.`,
        deniedMonths,
      );
    },
    keepShown(rows, monthOfRow) {
      return rows.filter((r) => {
        const m = monthOfRow(r);
        return !!m && shown(m);
      });
    },
    info,
  };
}

/**
 * Decide which months of a non-engine report the caller may see. Never throws for a
 * governance reason (use `assertAllShown` / `governRoute` for that); throws only on I/O.
 */
export async function governRouteMonths(ctx: RouteGuardContext, req: RouteGuardRequest): Promise<RouteGovernance> {
  const audience = await resolveRouteAudience(ctx);
  const finance = audience.audience === 'finance';
  const months = Array.from(new Set(req.months)).sort();
  if (!ctx.orgId) return deniedAll(audience.audience, months, [], 'No organization.');
  if (months.some((m) => !isPeriodKey(m))) return deniedAll(audience.audience, months, [], 'Invalid period.');

  const ids = req.locationIds.length
    ? Array.from(new Set(req.locationIds))
    : await (ctx.deps?.listLocations ?? listOrgLocations)(ctx.supabase, ctx.orgId);
  if (ids.length === 0 && !finance) return deniedAll(audience.audience, months, ids, 'No companies in scope.');
  if (months.length > MAX_GUARD_MONTHS && !finance) return deniedAll(audience.audience, months, ids, 'Range too long.');

  const load = memo(ctx.deps?.loadFacts ?? loadGovernanceFacts);
  const scopeKind: ScopeKind = req.scopeKind ?? (ids.length > 1 ? 'combined' : 'company');
  const includePreview = ctx.includePreview !== false;
  const base: GovernanceRequestContext = {
    supabase: ctx.supabase,
    orgId: ctx.orgId,
    userId: ctx.userId ?? '',
    includePreview,
    now: ctx.now,
    audience,
    deps: { loadFacts: load },
  };
  const displayMonths = months.length ? months : [];
  const decision = await applyGovernance({ periods: displayMonths.slice(-MAX_GUARD_MONTHS), locationIds: ids, scopeKind }, base);

  // Finance with preview: pass through (labelled by `info`).
  if (finance && decision.includePreview) return build(audience.audience, decision, months, ids, () => true);

  // The gate decision also covers each company's history for cumulative views.
  let gate = decision;
  const history = new Map<PeriodKey, PeriodKey[]>();
  if (req.cumulative && months.length && ids.length) {
    const first = firstPeriodOf(await load(ctx.supabase, ctx.orgId, ids), ids);
    const all = new Set<PeriodKey>(months);
    for (const m of months) {
      const h = historyOf(first, m);
      history.set(m, h);
      for (const k of h) all.add(k);
    }
    if (all.size > months.length) {
      gate = await applyGovernance({ periods: Array.from(all).sort(), locationIds: ids, scopeKind }, base);
    }
  }
  const idx = cellIndex(gate);
  const cell = (m: PeriodKey, id: string) => idx.get(m)?.get(id) ?? null;

  /** The month itself: released, in scope, and (non-finance) inside the group window. */
  const cellShown = (m: PeriodKey, id: string): boolean => {
    const c = cell(m, id);
    if (!c || c.visibility === 'out_of_scope') return false;
    if (!finance && c.visibility === 'excluded') return false;
    return c.release.released;
  };
  /** A history month of a balance: released (window does not matter), unless no period. */
  const historyShown = (m: PeriodKey, id: string): boolean => {
    const c = cell(m, id);
    if (!c || c.visibility === 'out_of_scope') return false;
    if (c.closeStatus === 'NO_PERIOD') return true;
    return c.release.released;
  };
  const companyShown = (m: PeriodKey, id: string): boolean => {
    if (!cellShown(m, id)) return false;
    if (!req.cumulative) return true;
    for (const h of history.get(m) ?? []) {
      if (h >= m) break;
      if (!historyShown(h, id)) return false;
    }
    return true;
  };
  const memoShown = new Map<string, boolean>();
  const shown = (m: PeriodKey, id?: string): boolean => {
    const key = `${m}|${id ?? '*'}`;
    const hit = memoShown.get(key);
    if (hit !== undefined) return hit;
    let out: boolean;
    if (!months.includes(m)) out = false;
    else if (id) out = ids.includes(id) && companyShown(m, id);
    else out = ids.length > 0 && ids.every((x) => companyShown(m, x));
    memoShown.set(key, out);
    return out;
  };
  return build(audience.audience, decision, months, ids, shown);
}

/** 403 body for a governance denial. */
export function notReleasedResponse(e: GovernanceDeniedError): NextResponse {
  return NextResponse.json({ error: e.message, code: 'NOT_RELEASED', periodKeys: e.periodKeys }, { status: 403 });
}

/**
 * The single-call form for single-period / as-of / range surfaces: every requested month
 * must be shown, else a 403 NOT_RELEASED response. Finance passes through.
 */
export async function governRoute(ctx: RouteGuardContext, req: RouteGuardRequest): Promise<RouteGovernance | NextResponse> {
  const g = await governRouteMonths(ctx, req);
  try {
    g.assertAllShown();
  } catch (e) {
    if (e instanceof GovernanceDeniedError) return notReleasedResponse(e);
    throw e;
  }
  return g;
}

/** Map a thrown GovernanceDeniedError to its 403 (null for anything else). */
export function governanceDeniedResponse(e: unknown): NextResponse | null {
  return e instanceof GovernanceDeniedError ? notReleasedResponse(e) : null;
}

/** A range the guard cannot cover (too long / malformed) → 400 for every audience. */
export function rangeTooLongResponse(): NextResponse {
  return NextResponse.json(
    { error: `The date range is too long (at most ${MAX_GUARD_MONTHS} months).`, code: 'RANGE_TOO_LONG' },
    { status: 400 },
  );
}

/**
 * Govern an ISO date range (P&L-style: every month in it must be shown). `cumulative` for a
 * range that also carries opening balances (cash flow beginning cash, equity roll-forward).
 * A range past the cap: finance passes (labelled by its last months), others get 400.
 */
export async function governDateRange(
  ctx: RouteGuardContext,
  req: { startDate: string; endDate: string; locationIds: readonly string[]; scopeKind?: ScopeKind; cumulative?: boolean },
): Promise<RouteGovernance | NextResponse> {
  if (!isPeriodKey(monthOf(req.startDate)) || !isPeriodKey(monthOf(req.endDate))) {
    return NextResponse.json({ error: 'start_date and end_date must be YYYY-MM-DD', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const months = rangeMonths(req.startDate, req.endDate);
  if (months === null) {
    const audience = await resolveRouteAudience(ctx);
    if (audience.audience !== 'finance') return rangeTooLongResponse();
    const tail = rangeMonths(`${addMonths(monthOf(req.endDate), -(MAX_GUARD_MONTHS - 1))}-01`, req.endDate) ?? [];
    return governRoute({ ...ctx, audience }, { months: tail, locationIds: req.locationIds, scopeKind: req.scopeKind, cumulative: req.cumulative });
  }
  return governRoute(ctx, { months, locationIds: req.locationIds, scopeKind: req.scopeKind, cumulative: req.cumulative });
}

/** The as-of month of an ISO date. */
export function asOfMonth(isoDate: string): PeriodKey {
  return monthOf(isoDate);
}

export { GovernanceDeniedError };
