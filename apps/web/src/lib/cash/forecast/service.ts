/**
 * Cash workspace service (Wave 4C) — orchestrates load → assemble → scenario → engine → liquidity
 * → recommendations, plus history, runway, accuracy and snapshots. SERVER ONLY.
 *
 * Reads go through the client handed in (the caller's RLS client in routes; the scheduler's system
 * tenant client in the job). Writes (snapshots, alert events) go through the `writer` handed in —
 * the service role, AFTER the route's permission + client-scope checks (171 / 189 pattern), always
 * with an explicit org_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sumCashAsOf } from '@/lib/cash/book-cash';
import { notifyMembers, tenantAdminMemberships } from '@/lib/notify/in-app';
import { assembleItems, type CompanyInput } from './assemble';
import { actualWeeks, completedWeeks, computeAccuracy, sumSnapshots, toSnapshotWeeks, type AccuracyReport, type SnapshotRow, type SnapshotWeek } from './accuracy';
import { addDays, addMonths, endOfMonth, mondayOf, startOfMonth } from './dates';
import { buildCashForecast, ENGINE_VERSION, forecastBridge, horizonEndOf, topItems, type CashForecast, type ScopeForecast } from './engine';
import { buildCashHistory, computeRunway, historyDates, type HistoryGrain, type RunwayResult } from './history';
import { availableByCompany, availableLines, recommend, type AvailableLine, type Recommendation } from './liquidity';
import {
  companyInputs,
  loadBankAccounts,
  loadBankTxns,
  loadCashLinesDetailed,
  loadCompanies,
  loadForecastInputs,
  loadLiquidity,
  loadScenarios,
  loadSettings,
  loadSnapshots,
  type BankAccountRow,
  type CompanyRow,
  type DetailedCashLines,
  type ScenarioRow,
} from './load';
import { applyScenario } from './scenario';
import { directionOf, type ForecastItem } from './types';

export type OpeningBasis = 'BOOK' | 'BANK_FEED';

export interface CompanyPosition {
  id: string;
  name: string;
  bookCents: number;
  bankCents: number | null;
  /** book − bank (reconciliation reference). */
  unreconciledCents: number | null;
  openingCents: number;
  openingBasis: OpeningBasis;
  minimumCents: number;
  alertsEnabled: boolean;
  accounts: Array<BankAccountRow & { stale: boolean }>;
  staleCount: number;
  lastFeedAt: string | null;
}

export interface WorkspaceForecast {
  today: string;
  forecast: CashForecast;
  scenario: { id: string | null; name: string; kind: ScenarioRow['kind'] | 'BASE'; adjustmentCount: number; touched: Record<string, number> };
  scenarios: Array<Pick<ScenarioRow, 'id' | 'name' | 'kind' | 'companyId'>>;
  positions: CompanyPosition[];
  liquidity: { lines: AvailableLine[]; availableByCompany: Record<string, number>; totalAvailableCents: number };
  recommendations: Recommendation[];
  atRisk: { totalCents: number; byCompany: Record<string, number> };
  runRate: ReturnType<typeof assembleItems>['runRate'];
  bridge: ReturnType<typeof forecastBridge>;
  top: { receipts: ForecastItem[]; disbursements: ForecastItem[] };
  accuracy: { mape: number | null; accuracy: number | null; snapshotsOnFile: number };
  notes: string[];
}

const STALE_DAYS = 4;

/** The companies a request covers: all the caller's (already scope-filtered) companies, or one. */
export function pickCompanies(all: readonly CompanyRow[], locationId: string | null): CompanyRow[] {
  return locationId ? all.filter((c) => c.id === locationId) : [...all];
}

export function positionsFrom(companies: readonly CompanyInput[], cash: DetailedCashLines, banks: readonly BankAccountRow[], today: string, basis: OpeningBasis, now: Date): CompanyPosition[] {
  const book = sumCashAsOf(cash.lines, cash.cashIds, today, companies.map((c) => c.id));
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  return companies.map((c) => {
    const accounts = banks
      .filter((b) => b.companyId === c.id)
      .map((b) => ({ ...b, stale: !b.updatedAt || new Date(b.updatedAt).getTime() < staleBefore }));
    const cashAccts = accounts.filter((a) => a.type === 'CHECKING' || a.type === 'SAVINGS');
    const bank = cashAccts.length ? cashAccts.reduce((s, a) => s + (a.currentCents ?? 0), 0) : null;
    const bookCents = book.byLocation[c.id] ?? 0;
    const opening = basis === 'BOOK' ? bookCents : (bank ?? 0);
    const last = accounts.reduce<string | null>((m, a) => (a.updatedAt && (!m || a.updatedAt > m) ? a.updatedAt : m), null);
    return {
      id: c.id,
      name: c.name,
      bookCents,
      bankCents: bank,
      unreconciledCents: bank === null ? null : bookCents - bank,
      openingCents: opening,
      openingBasis: basis,
      minimumCents: c.settings.minimumCashCents,
      alertsEnabled: c.settings.alertsEnabled,
      accounts,
      staleCount: accounts.filter((a) => a.stale).length,
      lastFeedAt: last,
    };
  });
}

function parseSnapshotWeeks(raw: unknown): SnapshotWeek[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
    .map((w) => ({
      start: String(w.start ?? ''),
      inflows: (w.inflows && typeof w.inflows === 'object' ? w.inflows : {}) as SnapshotWeek['inflows'],
      outflows: (w.outflows && typeof w.outflows === 'object' ? w.outflows : {}) as SnapshotWeek['outflows'],
      closing: Number(w.closing ?? 0),
    }));
}

export async function accuracyReport(
  db: SupabaseClient,
  orgId: string,
  cash: DetailedCashLines,
  today: string,
  scopeCompanyId: string | null,
  companyIds: readonly string[],
  opts: { weeks?: number; lead?: number; shownWeek?: (weekStart: string) => boolean } = {},
): Promise<AccuracyReport> {
  const n = opts.weeks ?? 12;
  const lead = opts.lead ?? 1;
  const weeks = completedWeeks(today, n).filter((w) => (opts.shownWeek ? opts.shownWeek(w) : true));
  const snaps = (await loadSnapshots(db, orgId, addDays(weeks[0] ?? today, -7 * (lead + 1)))).map<SnapshotRow>((r) => ({
    anchorDate: r.anchorDate,
    companyId: r.companyId,
    openingCents: r.openingCents,
    weeks: parseSnapshotWeeks(r.weeks),
  }));
  const ids = scopeCompanyId ? new Set([scopeCompanyId]) : new Set(companyIds);
  const actual = actualWeeks(cash.lines, weeks, ids);
  // Multi-company scope: Σ the companies' own snapshots (like-for-like with per-company GL actuals).
  const scoped = scopeCompanyId ? snaps : sumSnapshots(snaps, companyIds);
  return computeAccuracy(scoped, actual, weeks, scopeCompanyId, lead);
}

export interface ForecastRequest {
  orgId: string;
  companies: CompanyRow[];
  today: string;
  scenarioId: string | null;
  openingBasis: OpeningBasis;
  /** Score accuracy for the band (skipped by the snapshot job — it is the base truth). */
  withAccuracy?: boolean;
  /** Months whose GL actuals the caller may see (accuracy actuals). */
  shownWeek?: (weekStart: string) => boolean;
  now?: Date;
  /** Cash lines already loaded by the caller (one read per request). */
  cash?: DetailedCashLines;
}

export async function computeWorkspaceForecast(db: SupabaseClient, req: ForecastRequest): Promise<WorkspaceForecast> {
  const today = req.today;
  const horizonEnd = horizonEndOf(today);
  const ids = req.companies.map((c) => c.id);
  const settings = await loadSettings(db, ids);
  const companies = companyInputs(req.companies, settings);
  const [cash, banks, scenarios] = await Promise.all([
    req.cash ?? loadCashLinesDetailed(db, req.orgId, ids, today),
    loadBankAccounts(db, ids),
    loadScenarios(db, req.orgId),
  ]);
  const inputs = await loadForecastInputs(db, { orgId: req.orgId, companies, today, horizonEnd });
  const liq = await loadLiquidity(db, ids, banks);

  const scenario = req.scenarioId ? scenarios.find((s) => s.id === req.scenarioId) ?? null : null;
  if (req.scenarioId && !scenario) throw Object.assign(new Error('That scenario does not exist or was archived.'), { status: 404 });
  const assembled = assembleItems(inputs, { today, horizonEnd }, scenario?.id ?? null);

  // Base-level adjustments live on a BASE scenario row (if one exists) and apply to every scenario.
  const baseRow = scenarios.find((s) => s.kind === 'BASE');
  const adjustments = [
    ...(baseRow && baseRow.id !== scenario?.id ? baseRow.adjustments : []),
    ...(scenario?.adjustments ?? []),
  ].filter((a) => !a.companyId || ids.includes(a.companyId));
  const applied = applyScenario(assembled.items, adjustments, today);

  const positions = positionsFrom(companies, cash, banks, today, req.openingBasis, req.now ?? new Date());

  let mapeVal: number | null = null;
  let acc: AccuracyReport | null = null;
  if (req.withAccuracy !== false) {
    try {
      acc = await accuracyReport(db, req.orgId, cash, today, ids.length === 1 ? ids[0] : null, ids, { weeks: 8, shownWeek: req.shownWeek });
      const scored = acc.weeks.filter((w) => w.forecastInflows !== null).length;
      if (scored >= 4 && acc.inflowMape !== null && acc.outflowMape !== null) mapeVal = Math.min(1, (acc.inflowMape + acc.outflowMape) / 2);
    } catch {
      acc = null; // accuracy is a nice-to-have on the forecast screen; never fail the forecast for it
    }
  }

  const forecast = buildCashForecast({
    today,
    companies: positions.map((p) => ({ id: p.id, name: p.name, openingCents: p.openingCents, minimumCents: p.minimumCents })),
    items: applied.items,
    mape: mapeVal,
  });

  const lines = availableLines(liq.rows, liq.banks, liq.instruments);
  const avail = availableByCompany(lines, applied.lineMovement);
  const recs = recommend(forecast.companies, avail);

  const scope: ScopeForecast = forecast.combined;
  const notes = [...assembled.notes];
  if (req.openingBasis === 'BANK_FEED') notes.push('This month’s books are not released to you yet, so the forecast starts from the bank-feed balance.');
  if (assembled.dedupe.subscriptionsMatchedToBills) notes.push(`${assembled.dedupe.subscriptionsMatchedToBills} subscription renewal(s) already have a bill, so only the bill is counted.`);
  if (assembled.dedupe.leasesMatchedToBills) notes.push(`${assembled.dedupe.leasesMatchedToBills} lease payment(s) already have a bill, so only the bill is counted.`);
  if (forecast.intercompanyExcluded.count) notes.push(`${forecast.intercompanyExcluded.count} intercompany item(s) are left out of the all-companies view (they net to zero for the group).`);

  return {
    today,
    forecast,
    scenario: {
      id: scenario?.id ?? null,
      name: scenario?.name ?? 'Base forecast',
      kind: scenario?.kind ?? 'BASE',
      adjustmentCount: adjustments.length,
      touched: Object.fromEntries(applied.touched),
    },
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, kind: s.kind, companyId: s.companyId })),
    positions,
    liquidity: { lines, availableByCompany: Object.fromEntries(avail), totalAvailableCents: Array.from(avail.values()).reduce((a, b) => a + b, 0) },
    recommendations: recs,
    atRisk: { totalCents: assembled.atRiskCents, byCompany: Object.fromEntries(assembled.atRiskByCompany) },
    runRate: assembled.runRate,
    bridge: forecastBridge(scope),
    top: { receipts: topItems(forecast, 'combined', 'IN'), disbursements: topItems(forecast, 'combined', 'OUT') },
    accuracy: { mape: mapeVal, accuracy: acc?.accuracy ?? null, snapshotsOnFile: acc?.snapshotsOnFile ?? 0 },
    notes,
  };
}

// ── history + runway ───────────────────────────────────────────────────────────

export interface HistoryRequest {
  orgId: string;
  companyIds: string[];
  today: string;
  grain: HistoryGrain;
  points: number;
  /** May this date's book balance be shown (governance, cumulative)? */
  shown?: (date: string) => boolean;
}

export async function computeHistory(db: SupabaseClient, req: HistoryRequest) {
  const dates = historyDates(req.today, req.grain, req.points);
  const [cash, banks] = await Promise.all([loadCashLinesDetailed(db, req.orgId, req.companyIds, req.today), loadBankAccounts(db, req.companyIds)]);
  const cashAccts = banks.filter((b) => b.type === 'CHECKING' || b.type === 'SAVINGS');
  const bankCurrent = cashAccts.length ? cashAccts.reduce((s, a) => s + (a.currentCents ?? 0), 0) : null;
  const since = dates[0];
  const txns = await loadBankTxns(db, cashAccts.map((a) => a.id), since);
  const h = buildCashHistory({
    lines: cash.lines,
    cashIds: cash.cashIds,
    dates,
    locationIds: req.companyIds,
    bankCurrentCents: bankCurrent,
    bankTxns: txns,
    shown: req.shown,
  });
  return { ...h, grain: req.grain, bankAccountCount: cashAccts.length, bankTxnCount: txns.length };
}

export interface RunwayRequest {
  orgId: string;
  companyIds: string[];
  today: string;
  forecastNetCents: number;
  availableLinesCents: number;
  zeroCashDate: string | null;
  cashNowCents: number;
  shown?: (date: string) => boolean;
}

export async function computeRunwayFor(db: SupabaseClient, req: RunwayRequest, cash?: DetailedCashLines): Promise<RunwayResult & { monthEnds: Array<{ date: string; cents: number | null }> }> {
  const lines = cash ?? (await loadCashLinesDetailed(db, req.orgId, req.companyIds, req.today));
  const ends = [4, 3, 2, 1].map((k) => endOfMonth(addMonths(startOfMonth(req.today), -k)));
  const vals = ends.map((d) => (req.shown && !req.shown(d) ? null : sumCashAsOf(lines.lines, lines.cashIds, d, req.companyIds).totalCents));
  // No posted cash before the earliest month-end → not enough history (never a fake burn).
  const first = lines.lines.reduce<string | null>((m, l) => (!m || l.entryDate < m ? l.entryDate : m), null);
  const monthEnds = ends.map((d, i) => ({ date: d, cents: first && first <= d ? vals[i] : null }));
  const r = computeRunway({
    cashCents: req.cashNowCents,
    monthEnds: monthEnds.map((m) => m.cents),
    forecastNetCents: req.forecastNetCents,
    availableLinesCents: req.availableLinesCents,
    zeroCashDate: req.zeroCashDate,
  });
  return { ...r, monthEnds };
}

// ── snapshots + minimum-cash alerts ─────────────────────────────────────────────

export interface SnapshotOutcome {
  anchorDate: string;
  written: number;
  skipped: number;
  alerts: number;
  breaches: Array<{ companyId: string; name: string; weekIndex: number; shortfallCents: number }>;
}

/**
 * Snapshot the BASE forecast for every company and the combined view (one row each per Monday;
 * a re-run that week is a no-op), and raise one minimum-cash notification per company × week.
 * `reader` = RLS / system tenant client; `writer` = service role (explicit org_id on every row).
 *
 * Security review H4: the combined (location_id NULL) row is the WHOLE org's forecast. It is
 * written only when `combined` is true — the weekly job (system scope), or a manual snapshot by
 * a caller with all-clients scope covering every company. A scoped caller's manual snapshot
 * writes only its own companies' rows, so it can never plant a partial "combined" row that the
 * weekly job would then skip. Rows already on file for the week (either source) are skipped up
 * front — snapshots are append-only, so the first one of the week stands.
 */
export async function takeSnapshots(
  reader: SupabaseClient,
  writer: SupabaseClient,
  opts: {
    orgId: string;
    today: string;
    source: 'SCHEDULED' | 'MANUAL';
    actor: string | null;
    companies?: CompanyRow[];
    alerts?: boolean;
    /** Write the combined (all-companies) row. Default: only when no explicit company list is given (the job). */
    combined?: boolean;
    /** The forecast computation (tests inject one; default computeWorkspaceForecast). */
    compute?: typeof computeWorkspaceForecast;
  },
): Promise<SnapshotOutcome> {
  const companies = opts.companies ?? (await loadCompanies(reader, opts.orgId));
  const anchor = mondayOf(opts.today);
  const out: SnapshotOutcome = { anchorDate: anchor, written: 0, skipped: 0, alerts: 0, breaches: [] };
  if (!companies.length) return out;
  const ws = await (opts.compute ?? computeWorkspaceForecast)(reader, { orgId: opts.orgId, companies, today: opts.today, scenarioId: null, openingBasis: 'BOOK', withAccuracy: false });
  const f = ws.forecast;
  const isIn = (c: Parameters<typeof directionOf>[0]) => directionOf(c) === 'IN';
  const withCombined = (opts.combined ?? opts.companies === undefined) && companies.length > 1;
  const scopes: Array<{ companyId: string | null; s: ScopeForecast }> = [
    ...f.companies.map((s) => ({ companyId: s.scopeId, s })),
    ...(withCombined ? [{ companyId: null, s: f.combined }] : []),
  ];
  // Already on file this week (manual or scheduled): skip, never collide.
  const { data: existingRows, error: exErr } = await writer
    .from('cash_forecast_snapshots')
    .select('location_id')
    .eq('org_id', opts.orgId)
    .eq('anchor_date', anchor);
  if (exErr) throw new Error(`Could not read this week's forecast snapshots: ${exErr.message}`);
  const taken = new Set(((existingRows ?? []) as Array<{ location_id: string | null }>).map((r) => r.location_id ?? '*'));
  for (const { companyId, s } of scopes) {
    if (taken.has(companyId ?? '*')) {
      out.skipped += 1;
      continue;
    }
    const { error } = await writer.from('cash_forecast_snapshots').insert({
      org_id: opts.orgId,
      location_id: companyId,
      anchor_date: anchor,
      horizon_weeks: f.horizonWeeks,
      opening_cents: s.openingCents,
      closing_cents: s.closingCents,
      weeks: toSnapshotWeeks(s.weeks.map((w) => ({ start: w.start, byCategory: w.byCategory, closingCents: w.closingCents })), isIn),
      engine_version: ENGINE_VERSION,
      source: opts.source,
      created_by: opts.actor,
    });
    if (!error) out.written += 1;
    else if ((error as { code?: string }).code === '23505' || /duplicate|unique/i.test(error.message)) out.skipped += 1;
    else throw new Error(`Could not save the forecast snapshot: ${error.message}`);
  }
  if (out.written > 0) {
    await writer.from('cash_forecast_events').insert({
      org_id: opts.orgId,
      location_id: companies.length === 1 ? companies[0].id : null,
      event_kind: 'SNAPSHOT_TAKEN',
      actor_user_id: opts.actor,
      meta: { anchor_date: anchor, written: out.written, source: opts.source },
    });
  }

  if (opts.alerts !== false) {
    const alertOn = new Map(ws.positions.map((p) => [p.id, p.alertsEnabled]));
    const breaching = f.companies.filter((s) => s.firstBreach && alertOn.get(s.scopeId) !== false);
    if (breaching.length) {
      const admins = await tenantAdminMemberships(writer, opts.orgId);
      for (const s of breaching) {
        const b = s.firstBreach!;
        out.breaches.push({ companyId: s.scopeId, name: s.name, weekIndex: b.weekIndex, shortfallCents: b.shortfallCents });
        const rec = ws.recommendations.find((r) => r.companyId === s.scopeId);
        const created = await notifyMembers(writer, admins, {
          orgId: opts.orgId,
          locationId: s.scopeId,
          kind: 'cash.minimum_breach',
          severity: 'critical',
          title: `${s.name}: cash forecast drops below minimum in week ${b.weekIndex + 1}`,
          body: rec?.summary ?? `Projected ${Math.round(b.shortfallCents / 100).toLocaleString('en-US')} dollars below the minimum by ${b.date}.`,
          deepLink: `/cash?tab=forecast&company=${s.scopeId}`,
          dedupeKey: `cash-min:${s.scopeId}:${anchor}`,
        });
        if (created > 0) {
          out.alerts += created;
          await writer.from('cash_forecast_events').insert({
            org_id: opts.orgId,
            location_id: s.scopeId,
            event_kind: 'MIN_CASH_ALERT',
            actor_user_id: opts.actor,
            meta: { anchor_date: anchor, week: b.weekIndex + 1, shortfall_cents: b.shortfallCents, notified: created },
          });
        }
      }
    }
  }
  return out;
}
