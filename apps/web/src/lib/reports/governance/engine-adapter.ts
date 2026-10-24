/**
 * The 3A report-engine governance implementation (registered by ./index.ts through
 * lib/reports/engine/governance-hook.ts). Every engine ReportResult passes through here
 * before it leaves the server:
 *
 *   - amount columns whose (month × company) cells are not released for the caller are
 *     WITHHELD: values, F/U markers, drill and chart points become null and the column says
 *     "Not released" (non-finance, or finance with preview off). Columns derived from a
 *     withheld column (variance, common size) are withheld too.
 *   - forecast columns are gated like actuals for every month the forecast fills with
 *     ACTUALS (closed months — aggregate.forecastMap); budget-only months / columns pass.
 *   - a balance-sheet column (start = null, inception) is gated on EVERY month from each
 *     company's first fiscal period through its end, so a hidden month can never be derived
 *     by subtracting two released balance sheets (releases are also in order — policy.ts).
 *   - pre-acquisition months a report did NOT window out of its figures (trial balance /
 *     GL summary) are withheld for non-finance; finance sees them annotated.
 *   - when anything is withheld, amounts are stripped from the side channels too: check
 *     differences, warning amounts / texts, notes that embed cents.
 *   - finance sees unreleased columns as preview (listed in governance.previewColumnIds,
 *     banner + watermark 'preview').
 *   - released figures are never altered.
 *
 * The drill (GL lines behind a cell) is governed by `governDrillRequest`: every month of the
 * drill range must be released for the caller, and the in-group windows are computed HERE,
 * server-side (client windows can only narrow further).
 */

import type { DrillGovernanceContext, DrillGovernanceRequest, GovernanceContext, MembershipRequest } from '@/lib/reports/engine/governance-hook';
import type { DrillWindow, GroupWindow, ReportColumn, ReportResult } from '@/lib/reports/engine/types';
import { applyGovernance, type GovernanceRequestContext } from './apply';
import { permissionProbe, resolveGovernanceAudience, ResolvedAudience, type CapabilityProbe } from './audience';
import { GovernanceDeniedError } from './filter';
import { loadGovernanceFacts } from './load';
import { addMonths, monthEnd, monthLabel, monthList, monthOf, monthRange, periodKey } from './periods';
import type { CompanyPeriodDecision, GovernanceDecision, GovernanceFacts, PeriodKey, ScopeKind } from './types';

type CellGate = 'shown' | 'preview' | 'excluded' | 'withheld';

/** The history a gate decision may cover (monthRange's cap). Earlier months are covered by
 *  the in-order release rule: a released month implies every earlier month is released. */
const MAX_GATE_MONTHS = 240;

type DecisionIndex = Map<PeriodKey, Map<string, CompanyPeriodDecision>>;

function indexDecision(d: GovernanceDecision): DecisionIndex {
  const out: DecisionIndex = new Map();
  for (const p of d.periods) out.set(p.key, new Map(p.companies.map((c) => [c.locationId, c])));
  return out;
}

function cellOf(idx: DecisionIndex, month: PeriodKey, companyId: string): CompanyPeriodDecision | null {
  return idx.get(month)?.get(companyId) ?? null;
}

function gateOf(c: CompanyPeriodDecision | null, includePreview: boolean): CellGate {
  if (!c) return 'withheld';
  if (c.visibility === 'excluded') return 'excluded';
  if (c.visibility === 'out_of_scope') return 'withheld';
  if (c.release.released) return 'shown';
  return includePreview ? 'preview' : 'withheld';
}

/** History gate (balance-sheet months before the as-of month): released or not — a
 *  company in the group at the as-of month carries its whole history, window or not. */
function historyGate(c: CompanyPeriodDecision | null, includePreview: boolean): CellGate {
  if (!c || c.visibility === 'out_of_scope') return 'withheld';
  if (c.release.released) return 'shown';
  return includePreview ? 'preview' : 'withheld';
}

export function columnMonths(col: Pick<ReportColumn, 'range'>): PeriodKey[] {
  const end = monthOf(col.range.end);
  if (!col.range.start) return [end];
  return monthRange(monthOf(col.range.start), end);
}

const AMOUNT_KINDS = new Set<ReportColumn['kind']>(['amount', 'total', 'elimination', 'debit', 'credit']);

/** Columns that carry ledger figures (actual, or a forecast that substitutes actuals). */
function isGovernedAmount(col: ReportColumn): boolean {
  return AMOUNT_KINDS.has(col.kind) && (col.source === 'actual' || col.source === 'forecast');
}

function isClosed(c: CompanyPeriodDecision | null): boolean {
  // Missing company = unknown → treat as closed (gated): fail closed.
  return !c || c.closeStatus === 'HARD_CLOSE' || c.closeStatus === 'SOFT_CLOSE';
}

export interface ColumnGovernance {
  withheld: Set<string>;
  preview: Set<string>;
  /** company ids with pre-acquisition months inside a column, per column */
  preAcquisition: Map<string, Set<string>>;
}

/**
 * Decide every column. PURE given the decisions. `gate` is the decision the cells are gated
 * on (it must cover each company's balance-sheet history — see governReportResult); it
 * defaults to `d`.
 */
export function governColumns(view: ReportResult, d: GovernanceDecision, gate: GovernanceDecision = d): ColumnGovernance {
  const all = view.companies.map((c) => c.id);
  const idx = indexDecision(gate);
  const gateMonths = gate.periods.map((p) => p.key).sort();
  const nonFinance = gate.audience !== 'finance';
  const windowed = new Set(view.groupWindowCompanyIds ?? []);
  const withheld = new Set<string>();
  const preview = new Set<string>();
  const preAcquisition = new Map<string, Set<string>>();
  for (const col of view.columns) {
    if (!isGovernedAmount(col)) continue;
    const ids = col.drill?.companyIds?.length ? col.drill.companyIds : all;
    let w = false;
    let pv = false;
    const mark = (g: CellGate, id: string) => {
      if (g === 'withheld') w = true;
      else if (g === 'preview') pv = true;
      else if (g === 'excluded') {
        // The figures still contain the months before the company joined (trial balance,
        // GL summary — the engine did not window them): withheld for non-finance.
        if (nonFinance && !windowed.has(id)) w = true;
        const set = preAcquisition.get(col.id) ?? new Set<string>();
        set.add(id);
        preAcquisition.set(col.id, set);
      }
    };
    const end = monthOf(col.range.end);
    if (col.source === 'forecast') {
      // aggregate.forecastMap: a month where every company is (soft-)closed is ACTUAL.
      if (col.range.start) {
        for (const m of columnMonths(col)) {
          if (!ids.every((id) => isClosed(cellOf(idx, m, id)))) continue;
          for (const id of ids) mark(gateOf(cellOf(idx, m, id), gate.includePreview), id);
        }
      }
    } else if (!col.range.start) {
      // Point in time: the as-of month, plus every earlier month with a fiscal period.
      for (const id of ids) {
        mark(gateOf(cellOf(idx, end, id), gate.includePreview), id);
        for (const m of gateMonths) {
          if (m >= end) break;
          const c = cellOf(idx, m, id);
          if (c && c.closeStatus === 'NO_PERIOD') continue; // before its first period / a gap
          mark(historyGate(c, gate.includePreview), id);
        }
      }
    } else {
      for (const m of columnMonths(col)) for (const id of ids) mark(gateOf(cellOf(idx, m, id), gate.includePreview), id);
    }
    if (w) withheld.add(col.id);
    else if (pv) preview.add(col.id);
  }
  // Derived columns follow what they derive from.
  let grew = true;
  while (grew) {
    grew = false;
    for (const col of view.columns) {
      if (withheld.has(col.id)) continue;
      if ((col.of && withheld.has(col.of)) || (col.against && withheld.has(col.against))) {
        withheld.add(col.id);
        grew = true;
      }
    }
  }
  for (const col of view.columns) {
    if (withheld.has(col.id) || preview.has(col.id)) continue;
    if ((col.of && preview.has(col.of)) || (col.against && preview.has(col.against))) preview.add(col.id);
  }
  return { withheld, preview, preAcquisition };
}

/** Strip money from free text (warnings / notes) — "123 cents", "$1,234.56", tie texts. */
export function redactAmounts(text: string): string {
  return text
    .replace(/shows -?\d+, parts sum to -?\d+/g, 'does not equal the sum of its parts')
    .replace(/-?\d[\d,]*(?:\.\d+)?\s*cents/g, 'an amount')
    .replace(/\(?-?\$\s?-?[\d,]+(?:\.\d+)?\)?/g, 'an amount');
}

const AMOUNT_TEXT = /-?\d[\d,]*(?:\.\d+)?\s*cents|\$\s?-?\d|shows -?\d+, parts sum to/;

/** Apply a decision to a ReportResult. PURE. `gate` — see governColumns. */
export function governResult(view: ReportResult, d: GovernanceDecision, gate: GovernanceDecision = d): ReportResult {
  const g = governColumns(view, d, gate);
  const idx = view.columns.map((c) => g.withheld.has(c.id));
  const anyWithheld = g.withheld.size > 0;
  const columns = view.columns.map((c) =>
    g.withheld.has(c.id) ? { ...c, sublabel: 'Not released', drill: null } : c,
  );
  const rows = view.rows.map((r) => ({
    ...r,
    values: r.values.map((v, i) => (idx[i] ? null : v)),
    fu: r.fu ? r.fu.map((v, i) => (idx[i] ? null : v)) : r.fu,
    cellDrill: r.cellDrill ? r.cellDrill.map((v, i) => (idx[i] ? null : v)) : r.cellDrill,
  }));
  const chartSeries = view.chartSeries.map((s) => ({
    ...s,
    points: s.points.map((p) => (g.withheld.has(p.columnId) ? { ...p, cents: null } : p)),
  }));
  // Side channels: a check / warning / note must not carry what a withheld column hides.
  const withheldCheckIds = new Set(
    view.columns.filter((c) => g.withheld.has(c.id)).flatMap((c) => [`bs:${c.id}`, `cf:${c.id}`, ...(c.sublabel ? [`tb:${c.sublabel}`] : [])]),
  );
  const checks = anyWithheld
    ? view.checks.filter((c) => !withheldCheckIds.has(c.id)).map((c) => ({ ...c, differenceCents: null }))
    : view.checks;
  const warnings = anyWithheld
    ? view.warnings.map((w) => {
        const { amountCents: _drop, ...rest } = w;
        return AMOUNT_TEXT.test(rest.message) ? { ...rest, message: redactAmounts(rest.message) } : rest;
      })
    : view.warnings;
  const baseNotes = anyWithheld ? view.notes.map((n) => (AMOUNT_TEXT.test(n) ? redactAmounts(n) : n)) : view.notes;

  const names = new Map(view.companies.map((c) => [c.id, c.name]));
  const pre = new Set<string>();
  for (const ids of g.preAcquisition.values()) for (const id of ids) pre.add(id);
  const notes = [...baseNotes, d.footnote];
  if (anyWithheld) notes.push(`${g.withheld.size} column(s) are not released for your audience and are left blank.`);
  const applied = new Set(view.groupWindowCompanyIds ?? []);
  for (const id of pre) {
    const ann = d.annotations.find((a) => a.locationId === id && (a.kind === 'pre_acquisition' || a.kind === 'pro_forma'));
    if (applied.has(id)) {
      // the engine already left the months outside the window out of every figure
      notes.push(ann ? ann.text : `${names.get(id) ?? 'A company'} is shown only for the months it is in the group.`);
    } else if (gate.audience !== 'finance') {
      notes.push(`${names.get(id) ?? 'A company'} joined the group during this period; columns that include months before then are left blank.`);
    } else {
      notes.push(ann ? `${ann.text} Figures here include months before then.` : `${names.get(id) ?? 'A company'} includes months before it joined the group.`);
    }
  }
  const shown = d.periods.filter((p) => p.visibility !== 'hidden');
  return {
    ...view,
    columns,
    rows,
    chartSeries,
    checks,
    warnings,
    notes,
    governance: {
      ...(view.governance ?? {}),
      booksClosedThrough: d.closedThrough.scope,
      releasedThrough: d.releasedThrough.scope,
      released: g.withheld.size === 0 && g.preview.size === 0,
      watermark: d.watermark === 'none' && g.preview.size === 0 ? null : g.preview.size > 0 ? 'preview' : d.watermark,
      restated: shown.some((p) => !!p.restatedOn),
      restatedMonths: shown.filter((p) => p.restatedOn).map((p) => ({ month: p.key, label: monthLabel(p.key), on: p.restatedOn })),
      audience: d.audience,
      banner: d.banner ?? (g.preview.size > 0 ? { tone: 'warn', text: 'Preview — includes months not yet released to partners.' } : null),
      footnote: d.footnote,
      annotations: d.annotations,
      withheldColumnIds: Array.from(g.withheld),
      previewColumnIds: Array.from(g.preview),
      preAcquisitionCompanyIds: Array.from(pre),
      months: d.periods.map((p) => ({ month: p.key, visibility: p.visibility, closeStatus: p.closeStatus, released: p.released, restatedOn: p.restatedOn })),
    },
  };
}

/** Every month any ACTUAL column touches (balance-sheet columns by their end month) — the
 *  months the header / footnote talk about. */
export function resultMonths(view: ReportResult): PeriodKey[] {
  const set = new Set<PeriodKey>();
  for (const col of view.columns) if (isGovernedAmount(col) && col.source === 'actual') for (const m of columnMonths(col)) set.add(m);
  return Array.from(set).sort();
}

/** resultMonths + every month a forecast column spans (its closed months are actuals). */
export function gatedMonths(view: ReportResult): PeriodKey[] {
  const set = new Set<PeriodKey>(resultMonths(view));
  for (const col of view.columns) if (isGovernedAmount(col) && col.source === 'forecast' && col.range.start) for (const m of columnMonths(col)) set.add(m);
  return Array.from(set).sort();
}

/** Latest end month of the point-in-time (inception) governed columns, or null. */
function inceptionEnd(view: ReportResult): PeriodKey | null {
  let out: PeriodKey | null = null;
  for (const col of view.columns) {
    if (!isGovernedAmount(col) || col.source !== 'actual' || col.range.start) continue;
    const m = monthOf(col.range.end);
    if (out === null || m > out) out = m;
  }
  return out;
}

/** The first month any of these companies has a fiscal period. */
export function firstPeriodMonth(facts: GovernanceFacts, ids: readonly string[]): PeriodKey | null {
  let out: PeriodKey | null = null;
  for (const id of ids) {
    for (const p of facts.companies[id]?.periods ?? []) {
      const k = periodKey(p.year, p.month);
      if (out === null || k < out) out = k;
    }
  }
  return out;
}

/** Months [from(or the cap) … end]: the history a point-in-time gate must cover. */
function historyMonths(first: PeriodKey | null, end: PeriodKey): PeriodKey[] {
  const floor = addMonths(end, -(MAX_GATE_MONTHS - 1));
  const from = first && first < end ? (first < floor ? floor : first) : end;
  return monthRange(from, end);
}

const NO_USER_PROBE: CapabilityProbe = { has: async () => false };

type FactsLoader = NonNullable<NonNullable<GovernanceRequestContext['deps']>['loadFacts']>;

/** One facts read per request, however many decisions are taken from it. */
function memoLoader(load: FactsLoader): FactsLoader {
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

interface Prepared {
  audience: ResolvedAudience;
  load: FactsLoader;
  base: GovernanceRequestContext;
}

async function prepare(ctx: DrillGovernanceContext, deps?: GovernanceRequestContext['deps']): Promise<Prepared> {
  // No user → no capabilities → partner view (fail closed).
  const probe = deps?.probe ?? (ctx.userId ? permissionProbe(ctx.userId) : NO_USER_PROBE);
  const audience = await resolveGovernanceAudience(probe);
  const load = memoLoader(deps?.loadFacts ?? loadGovernanceFacts);
  return {
    audience,
    load,
    base: { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId ?? '', includePreview: ctx.preview !== false, audience, deps: { ...deps, loadFacts: load } },
  };
}

/** The registered hook: decide (server-side audience) then govern the result. */
export async function governReportResult(
  view: ReportResult,
  ctx: GovernanceContext,
  deps?: GovernanceRequestContext['deps'],
): Promise<ReportResult> {
  const shownMonths = resultMonths(view);
  const forecastMonths = gatedMonths(view);
  if (forecastMonths.length === 0) return view;
  const months = shownMonths.length ? shownMonths : forecastMonths;
  const ids = view.companies.map((c) => c.id);
  const scopeKind: ScopeKind = ctx.request.scope.consolidate ? 'consolidated' : ids.length > 1 ? 'combined' : 'company';
  const { load, base } = await prepare(ctx, deps);
  const decision = await applyGovernance({ periods: months, locationIds: ids, scopeKind }, base);
  // The gate decision also covers forecast months and each company's balance-sheet history
  // (a second decision over the same facts — the display decision keeps its banner /
  // footnote to the months the statement shows).
  const gateSet = new Set<PeriodKey>([...months, ...forecastMonths]);
  const end = inceptionEnd(view);
  if (end && ids.length) {
    const first = firstPeriodMonth(await load(ctx.supabase, ctx.orgId, ids), ids);
    for (const m of historyMonths(first, end)) gateSet.add(m);
  }
  const gate = gateSet.size > months.length
    ? await applyGovernance({ periods: Array.from(gateSet).sort(), locationIds: ids, scopeKind }, base)
    : decision;
  return governResult(view, decision, gate);
}

/**
 * In-group windows from a decision (PURE): for each company, the first and last month it is
 * NOT 'excluded' within the decided months. Only companies with an excluded month get a
 * window; a company excluded for every month gets an empty window (never in the group).
 * Windows are contiguous by construction (report_company_coverage from / until).
 */
export function windowsFromDecision(d: GovernanceDecision): Record<string, GroupWindow> {
  const out: Record<string, GroupWindow> = {};
  const keys = d.periods.map((p) => p.key).sort();
  if (keys.length === 0) return out;
  const idx = indexDecision(d);
  const ids = new Set(d.periods.flatMap((p) => p.companies.map((c) => c.locationId)));
  for (const id of ids) {
    const inMonths = keys.filter((k) => {
      const c = cellOf(idx, k, id);
      return !!c && c.visibility !== 'excluded';
    });
    const excludedAny = keys.some((k) => cellOf(idx, k, id)?.visibility === 'excluded');
    if (!excludedAny) continue;
    if (inMonths.length === 0) {
      out[id] = { from: '9999-12-01', until: null };
      continue;
    }
    const first = inMonths[0];
    const last = inMonths[inMonths.length - 1];
    out[id] = { from: first > keys[0] ? `${first}-01` : null, until: last < keys[keys.length - 1] ? `${last}-01` : null };
  }
  return out;
}

/**
 * The registered membership hook: which companies' in-group windows apply for this caller
 * and scope, decided BEFORE aggregation so the engine leaves pre-acquisition (and
 * post-disposal) months out of every figure instead of only annotating them.
 * Out-of-scope companies never reach here (the engine refuses them first).
 */
export async function membershipFor(
  req: MembershipRequest,
  ctx: GovernanceContext,
  deps?: GovernanceRequestContext['deps'],
): Promise<Record<string, GroupWindow> | null> {
  const { base } = await prepare(ctx, deps);
  const decision = await applyGovernance({ periods: req.months, locationIds: req.companyIds, scopeKind: req.scopeKind }, base);
  const w = windowsFromDecision(decision);
  return Object.keys(w).length ? w : null;
}

// ─── drill ───────────────────────────────────────────────────────────────────

const NEVER: DrillWindow = { from: '9999-12-01', to: null };

/** GroupWindow (month starts) → DrillWindow (inclusive ISO dates). */
export function drillWindowOf(w: GroupWindow): DrillWindow {
  return { from: w.from, to: w.until ? monthEnd(monthOf(w.until)) : null };
}

/** Intersect two windows (both narrow): the later from, the earlier to. */
export function intersectWindows(a: DrillWindow | undefined, b: DrillWindow | undefined): DrillWindow | undefined {
  if (!a) return b;
  if (!b) return a;
  const from = a.from && b.from ? (a.from > b.from ? a.from : b.from) : a.from ?? b.from;
  const to = a.to && b.to ? (a.to < b.to ? a.to : b.to) : a.to ?? b.to;
  return { from, to };
}

export interface DrillGate {
  /** months the caller may not see (non-empty → refuse) */
  denied: PeriodKey[];
  /** windows the drill MUST apply (server-side), by company */
  windows: Record<string, DrillWindow>;
}

/**
 * Gate a drill (PURE given the decision): every month of the range must be shown for each
 * company (a point-in-time range: every month with a fiscal period through the as-of month).
 * Non-finance: months outside a company's in-group window are clipped by server windows (for
 * a point-in-time range a company outside the group at the as-of month is dropped, a member
 * keeps its whole history — mirroring the balance-sheet cell).
 */
export function gateDrill(d: GovernanceDecision, req: { companyIds: string[]; range: { start: string | null; end: string } }): DrillGate {
  const idx = indexDecision(d);
  const keys = d.periods.map((p) => p.key).sort();
  const end = monthOf(req.range.end);
  const start = req.range.start ? monthOf(req.range.start) : null;
  const denied = new Set<PeriodKey>();
  const finance = d.audience === 'finance';
  for (const id of req.companyIds) {
    for (const m of keys) {
      if (start !== null && m < start) continue;
      if (m > end) break;
      const c = cellOf(idx, m, id);
      if (start === null && m < end) {
        if (c && c.closeStatus === 'NO_PERIOD') continue;
        if (historyGate(c, d.includePreview) === 'withheld') denied.add(m);
        continue;
      }
      const g = gateOf(c, d.includePreview);
      if (g === 'withheld') denied.add(m);
    }
  }
  const windows: Record<string, DrillWindow> = {};
  if (!finance) {
    if (start === null) {
      for (const id of req.companyIds) if (cellOf(idx, end, id)?.visibility === 'excluded') windows[id] = NEVER;
    } else {
      const w = windowsFromDecision(d);
      for (const [id, gw] of Object.entries(w)) if (req.companyIds.includes(id)) windows[id] = drillWindowOf(gw);
    }
  }
  return { denied: Array.from(denied).sort(), windows };
}

/**
 * The registered drill hook: refuse (403 NOT_RELEASED) a drill into months the caller may not
 * see, and return the windows the drill must apply — computed server-side and intersected with
 * the client's (which can only narrow further).
 */
export async function governDrillRequest(
  req: DrillGovernanceRequest,
  ctx: DrillGovernanceContext,
  deps?: GovernanceRequestContext['deps'],
): Promise<Record<string, DrillWindow> | null> {
  const ids = Array.from(new Set(req.companyIds));
  if (ids.length === 0) throw new GovernanceDeniedError('No companies to drill into.', []);
  const end = monthOf(req.range.end);
  const { load, base } = await prepare(ctx, deps);
  let months: PeriodKey[];
  if (req.range.start) {
    const start = monthOf(req.range.start);
    const floor = addMonths(end, -(MAX_GATE_MONTHS - 1));
    months = monthRange(start < floor ? floor : start, end);
  } else {
    months = historyMonths(firstPeriodMonth(await load(ctx.supabase, ctx.orgId, ids), ids), end);
  }
  const decision = await applyGovernance({ periods: months, locationIds: ids, scopeKind: ids.length > 1 ? 'combined' : 'company' }, base);
  const g = gateDrill(decision, { companyIds: ids, range: req.range });
  if (g.denied.length) {
    throw new GovernanceDeniedError(`${monthList(g.denied.slice(0, 6))}${g.denied.length > 6 ? ' and more' : ''} ${g.denied.length === 1 ? 'is' : 'are'} not released for your audience.`, g.denied);
  }
  const out: Record<string, DrillWindow> = {};
  for (const id of ids) {
    const w = intersectWindows(g.windows[id], req.windows?.[id]);
    if (w) out[id] = w;
  }
  return Object.keys(out).length ? out : null;
}
