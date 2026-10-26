/**
 * NUMBER GOVERNANCE — the pure policy (FPB-tenant-model-consolidation-analytics §18.2–18.3).
 *
 *   releaseState(company, key, today)  → is this company-month released (explicit / auto, IN ORDER)?
 *   closedThrough(company)             → last month of the contiguous HARD_CLOSE run
 *   releasedThrough(company, today)    → latest released month
 *   evaluateGovernance(input)          → the GovernanceDecision every report / metric API enforces
 *
 * PURE: no I/O, no clock reads (today is an input). Exhaustively unit-tested.
 */

import {
  addDays,
  dateLabel,
  minKey,
  monthEnd,
  monthLabel,
  monthList,
  monthOf,
  parsePeriodKey,
  periodKey,
  statusRank,
  worstStatus,
} from './periods';
import type {
  CloseStatus,
  CompanyFacts,
  CompanyPeriodDecision,
  CompanyReleaseState,
  FiscalPeriodFact,
  GovernanceAnnotation,
  GovernanceDecision,
  GovernanceInput,
  HiddenReason,
  PeriodDecision,
  PeriodKey,
  PeriodVisibility,
  WatermarkMode,
} from './types';
import { CLOSE_STATE_LABEL, closedThroughText, companyCloseRun } from '@/lib/period/closed';

function periodFor(company: CompanyFacts, key: PeriodKey): FiscalPeriodFact | null {
  const { year, month } = parsePeriodKey(key);
  return company.periods.find((p) => p.year === year && p.month === month) ?? null;
}

export function closeStatusFor(company: CompanyFacts, key: PeriodKey): CloseStatus {
  return periodFor(company, key)?.status ?? 'NO_PERIOD';
}

/**
 * The month's OWN release state, ignoring earlier months: explicit row first (RELEASED /
 * WITHDRAWN), else the auto rule: enabled, month ended, today ≥ month end + N days, status ≥
 * the configured minimum. Use `releaseState` — a month is only released IN ORDER.
 */
function ownReleaseState(company: CompanyFacts, key: PeriodKey, today: string, idx?: CompanyIndex): CompanyReleaseState {
  const row = idx ? idx.releases.get(key) ?? null : findRelease(company, key);
  const period = idx ? idx.periods.get(key) ?? null : periodFor(company, key);
  const end = period?.endDate ?? monthEnd(key);
  const s = company.settings;
  const autoOn = s.autoReleaseEnabled ? addDays(end, s.autoReleaseDays) : null;

  let blockedBy: CompanyReleaseState['blockedBy'] = null;
  if (!period) blockedBy = 'no_period';
  else if (today <= end) blockedBy = 'not_ended';
  else if (period.status === 'OPEN') blockedBy = 'open';
  else if (period.status === 'SOFT_CLOSE' && s.autoReleaseMinStatus === 'HARD_CLOSE') blockedBy = 'soft_close_below_minimum';

  if (row?.status === 'RELEASED') {
    return { released: true, mode: row.mode, releasedOn: row.releasedAt, derived: false, withdrawn: false, autoReleaseOn: null, blockedBy: null };
  }
  if (row?.status === 'WITHDRAWN') {
    return { released: false, mode: null, releasedOn: null, derived: false, withdrawn: true, autoReleaseOn: null, blockedBy };
  }
  const autoEligible = autoOn !== null && blockedBy === null;
  if (autoEligible && today >= autoOn) {
    return { released: true, mode: 'AUTO', releasedOn: autoOn, derived: true, withdrawn: false, autoReleaseOn: autoOn, blockedBy: null };
  }
  return {
    released: false,
    mode: null,
    releasedOn: null,
    derived: false,
    withdrawn: false,
    // Show the auto date whenever the rule is on and the period could still qualify.
    autoReleaseOn: autoOn !== null && blockedBy !== 'no_period' ? autoOn : null,
    blockedBy,
  };
}

function findRelease(company: CompanyFacts, key: PeriodKey) {
  const { year, month } = parsePeriodKey(key);
  return company.releases.find((r) => r.year === year && r.month === month) ?? null;
}

interface CompanyIndex {
  periods: Map<PeriodKey, FiscalPeriodFact>;
  releases: Map<PeriodKey, CompanyFacts['releases'][number]>;
  /** period keys ascending */
  periodKeys: PeriodKey[];
}

function indexCompany(company: CompanyFacts): CompanyIndex {
  const periods = new Map<PeriodKey, FiscalPeriodFact>();
  for (const p of company.periods) periods.set(periodKey(p.year, p.month), p);
  const releases = new Map<PeriodKey, CompanyFacts['releases'][number]>();
  for (const r of company.releases) releases.set(periodKey(r.year, r.month), r);
  return { periods, releases, periodKeys: Array.from(periods.keys()).sort() };
}

/**
 * One company's release states, IN ORDER (FPB §18.2): a month counts as released only when
 * it is released by its own state AND every earlier month that has a fiscal period is
 * released too — so the auto rule can never leapfrog a withheld month, and a hidden month
 * can never be derived by subtracting two released balance sheets. Built once per company
 * (O(periods)); `get` is O(log periods).
 */
export function releaseTimeline(company: CompanyFacts, today: string): (key: PeriodKey) => CompanyReleaseState {
  const idx = indexCompany(company);
  // firstUnreleased[i] = the first period key among periodKeys[0..i] not released on its own.
  const firstUnreleased: Array<PeriodKey | null> = [];
  let first: PeriodKey | null = null;
  for (const k of idx.periodKeys) {
    if (first === null && !ownReleaseState(company, k, today, idx).released) first = k;
    firstUnreleased.push(first);
  }
  const memo = new Map<PeriodKey, CompanyReleaseState>();
  return (key) => {
    const hit = memo.get(key);
    if (hit) return hit;
    const own = ownReleaseState(company, key, today, idx);
    let out = own;
    if (own.released) {
      // number of period keys strictly before `key`
      let lo = 0;
      let hi = idx.periodKeys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (idx.periodKeys[mid] < key) lo = mid + 1;
        else hi = mid;
      }
      const held = lo > 0 ? firstUnreleased[lo - 1] : null;
      if (held) {
        out = { released: false, mode: null, releasedOn: null, derived: false, withdrawn: false, autoReleaseOn: own.autoReleaseOn, blockedBy: null, heldBy: held };
      }
    }
    memo.set(key, out);
    return out;
  };
}

/**
 * Is (company, month) released? Its own state (explicit row, else the auto rule) AND every
 * earlier month with a fiscal period released (`heldBy` names the first one that is not).
 */
export function releaseState(company: CompanyFacts, key: PeriodKey, today: string): CompanyReleaseState {
  return releaseTimeline(company, today)(key);
}

/**
 * The latest month with a fiscal period before `key` that is NOT released (in order) — a
 * release of `key` must wait for it. null = every earlier month is released.
 */
export function earlierUnreleased(company: CompanyFacts, key: PeriodKey, today: string): PeriodKey | null {
  const state = releaseTimeline(company, today);
  const prior = company.periods.map((p) => periodKey(p.year, p.month)).filter((k) => k < key).sort();
  const prev = prior.at(-1);
  if (!prev) return null;
  return state(prev).released ? null : prev;
}

/**
 * Can a person release this month by hand right now? (SOFT/HARD closed and ended.) The
 * in-order rule (the previous month must be released first) is checked separately —
 * `earlierUnreleased` — so the calendar can say which month to release first.
 */
export function manualReleaseBlock(company: CompanyFacts, key: PeriodKey, today: string): 'not_ended' | 'no_period' | 'open' | null {
  const period = periodFor(company, key);
  if (!period) return 'no_period';
  if (today <= period.endDate) return 'not_ended';
  if (period.status === 'OPEN') return 'open';
  return null;
}

/**
 * Books closed through — delegates to THE close resolver (lib/period/closed.ts) so governance,
 * the period picker and the calendar can never disagree: the contiguous HARD_CLOSE run from the
 * company's first closed month (open months before the first close are reported, not blocking).
 */
export function closedThrough(company: CompanyFacts): PeriodKey | null {
  return companyCloseRun(company.periods.map((p) => ({ key: periodKey(p.year, p.month), status: p.status }))).closedThrough;
}

/** Months before `closedThrough` that are still not closed (pre-close open months). */
export function openBeforeClosed(company: CompanyFacts): PeriodKey[] {
  return companyCloseRun(company.periods.map((p) => ({ key: periodKey(p.year, p.month), status: p.status }))).openBefore;
}

/** Latest released month (explicit or auto) among the company's periods and release rows. */
export function releasedThrough(company: CompanyFacts, today: string): PeriodKey | null {
  const keys = new Set<PeriodKey>();
  for (const p of company.periods) keys.add(periodKey(p.year, p.month));
  for (const r of company.releases) keys.add(periodKey(r.year, r.month));
  const state = releaseTimeline(company, today);
  let out: PeriodKey | null = null;
  for (const k of keys) {
    if (state(k).released && (out === null || k > out)) out = k;
  }
  return out;
}

/** Is the company in the group in this month (month granularity, inclusive)? */
export function inGroup(company: CompanyFacts, key: PeriodKey): boolean {
  const c = company.coverage;
  if (!c) return true;
  if (c.inGroupFrom && key < monthOf(c.inGroupFrom)) return false;
  if (c.inGroupUntil && key > monthOf(c.inGroupUntil)) return false;
  return true;
}

function latestRestatement(company: CompanyFacts, key: PeriodKey): { on: string | null; count: number } {
  const { year, month } = parsePeriodKey(key);
  const rs = company.restatements.filter((r) => r.year === year && r.month === month);
  if (rs.length === 0) return { on: null, count: 0 };
  const on = rs.map((r) => r.detectedAt).sort().at(-1) ?? null;
  return { on: on ? on.slice(0, 10) : null, count: rs.length };
}

const STATUS_WORDS: Record<CloseStatus, string> = {
  HARD_CLOSE: CLOSE_STATE_LABEL.closed.toLowerCase(),
  SOFT_CLOSE: CLOSE_STATE_LABEL.soft.toLowerCase(),
  OPEN: CLOSE_STATE_LABEL.open.toLowerCase(),
  NO_PERIOD: 'no period',
};

/**
 * THE decision. Enforcement rules:
 *  - a company the caller cannot read (not in facts) never contributes ('out_of_scope');
 *  - a company outside its in-group window that month is excluded, unless finance asked
 *    for pro forma (and, for a single-company view, finance sees its own books annotated);
 *  - non-finance (and finance with preview off): a month is shown only when EVERY included
 *    company is released — a combined figure can never contain unreleased numbers;
 *  - finance with preview on: unreleased months are 'preview' (banner + watermark).
 */
export function evaluateGovernance(input: GovernanceInput): GovernanceDecision {
  const { view, facts, audience, today } = input;
  const finance = audience === 'finance';
  const includePreview = finance && (input.options?.includePreview ?? true);
  const proForma = finance && (input.options?.proForma ?? false);
  const keys = Array.from(new Set(view.periods)).sort();
  const requested = Array.from(new Set(view.locationIds));
  const readable = requested.filter((id) => !!facts.companies[id]);
  const outOfScope = requested.filter((id) => !facts.companies[id]);
  const companies = readable.map((id) => facts.companies[id]);
  // Finance reading ONE company sees its own books before the group window (annotated);
  // everywhere else the window excludes, unless finance asked for pro forma.
  const windowExcludes = !(proForma || (finance && view.scopeKind === 'company'));

  const timelines = new Map(companies.map((c) => [c.locationId, releaseTimeline(c, today)] as const));

  const annotations: GovernanceAnnotation[] = [];
  const periods: PeriodDecision[] = [];
  const locationsByPeriod: Record<PeriodKey, string[]> = {};

  for (const key of keys) {
    const { year, month } = parsePeriodKey(key);
    const rows: CompanyPeriodDecision[] = [];
    for (const id of outOfScope) {
      rows.push({
        locationId: id,
        visibility: 'out_of_scope',
        closeStatus: 'NO_PERIOD',
        release: { released: false, mode: null, releasedOn: null, derived: false, withdrawn: false, autoReleaseOn: null, blockedBy: null },
        inGroup: false,
        restatedOn: null,
        restatementCount: 0,
      });
    }
    let periodProForma = false;
    const included: CompanyPeriodDecision[] = [];
    for (const c of companies) {
      const member = inGroup(c, key);
      const release = (timelines.get(c.locationId) as (k: PeriodKey) => CompanyReleaseState)(key);
      const rest = latestRestatement(c, key);
      const row: CompanyPeriodDecision = {
        locationId: c.locationId,
        visibility: 'hidden',
        closeStatus: closeStatusFor(c, key),
        release,
        inGroup: member,
        restatedOn: rest.on,
        restatementCount: rest.count,
      };
      if (!member && windowExcludes) {
        row.visibility = 'excluded';
      } else {
        if (!member) periodProForma = true;
        row.visibility = release.released ? 'visible' : includePreview ? 'preview' : 'hidden';
        included.push(row);
      }
      rows.push(row);
    }

    let visibility: PeriodVisibility;
    let hiddenReason: HiddenReason | null = null;
    if (requested.length === 0) {
      visibility = 'hidden';
      hiddenReason = 'no_companies';
    } else if (companies.length === 0) {
      visibility = 'hidden';
      hiddenReason = 'out_of_scope';
    } else if (included.length === 0) {
      visibility = 'hidden';
      hiddenReason = 'pre_acquisition';
    } else if (included.every((r) => r.release.released)) {
      visibility = 'visible';
    } else if (includePreview) {
      visibility = 'preview';
    } else {
      visibility = 'hidden';
      hiddenReason = 'not_released';
    }
    // A hidden month exposes no per-company "visible" rows either.
    if (visibility === 'hidden') for (const r of included) r.visibility = 'hidden';

    const closeStatus = included.reduce<CloseStatus>((acc, r) => worstStatus(acc, r.closeStatus), 'HARD_CLOSE');
    const effectiveClose: CloseStatus = included.length === 0 ? 'NO_PERIOD' : closeStatus;
    const restatedOn = included.map((r) => r.restatedOn).filter((d): d is string => !!d).sort().at(-1) ?? null;

    periods.push({
      key,
      year,
      month,
      visibility,
      hiddenReason,
      closeStatus: effectiveClose,
      unclosed: effectiveClose !== 'HARD_CLOSE',
      released: included.length > 0 && included.every((r) => r.release.released),
      restatedOn,
      proForma: periodProForma && visibility !== 'hidden',
      companies: rows,
    });
    locationsByPeriod[key] = visibility === 'hidden' ? [] : included.map((r) => r.locationId);
  }

  // ── closed / released through ────────────────────────────────────────────────
  const closedBy: Record<string, PeriodKey | null> = {};
  const releasedBy: Record<string, PeriodKey | null> = {};
  for (const c of companies) {
    closedBy[c.locationId] = closedThrough(c);
    releasedBy[c.locationId] = releasedThrough(c, today);
  }
  const lastKey = keys.at(-1) ?? null;
  // The scope figure is the earliest among companies in the group at the latest requested month.
  const scopeMembers = companies.filter((c) => (lastKey ? inGroup(c, lastKey) || !windowExcludes : true));
  const closedScope = scopeMembers.length ? minKey(scopeMembers.map((c) => closedBy[c.locationId])) : null;
  const releasedScope = scopeMembers.length ? minKey(scopeMembers.map((c) => releasedBy[c.locationId])) : null;

  // ── annotations, banner, watermark, footnote ────────────────────────────────
  annotations.push({
    kind: 'closed_through',
    text: `${closedThroughText(closedScope, closedScope ? openEarlierCount(scopeMembers, closedScope) : 0)}.`,
  });
  if (finance) {
    annotations.push({
      kind: 'released_through',
      text: releasedScope ? `Released to partners through ${monthLabel(releasedScope)}.` : 'Nothing has been released to partners yet.',
    });
  }
  const shown = periods.filter((p) => p.visibility !== 'hidden');
  const unclosedShown = shown.filter((p) => p.unclosed);
  for (const p of unclosedShown) {
    annotations.push({ kind: 'unclosed', periodKey: p.key, text: `${monthLabel(p.key)} is preliminary (${STATUS_WORDS[p.closeStatus]}).` });
  }
  for (const p of shown.filter((x) => x.restatedOn)) {
    annotations.push({ kind: 'restated', periodKey: p.key, text: `${monthLabel(p.key)} restated on ${dateLabel(p.restatedOn as string)}.` });
  }
  const previewKeys = periods.filter((p) => p.visibility === 'preview').map((p) => p.key);
  if (previewKeys.length) {
    annotations.push({ kind: 'preview', text: `${monthList(previewKeys)} not released — preview for finance only.` });
  }
  const hiddenUnreleased = periods.filter((p) => p.hiddenReason === 'not_released').map((p) => p.key);
  if (hiddenUnreleased.length) {
    annotations.push({ kind: 'hidden_unreleased', text: `${monthList(hiddenUnreleased)} not released yet.` });
  }
  for (const c of companies) {
    if (!c.coverage?.inGroupFrom) continue;
    const from = monthOf(c.coverage.inGroupFrom);
    if (keys.some((k) => k < from)) {
      annotations.push({
        kind: windowExcludes ? 'pre_acquisition' : 'pro_forma',
        locationId: c.locationId,
        text: windowExcludes
          ? `${c.name} is shown from ${monthLabel(from)}, when it joined the group.`
          : `Pro forma: includes ${c.name} before it joined the group in ${monthLabel(from)}.`,
      });
    }
  }
  if (outOfScope.length) {
    annotations.push({ kind: 'out_of_scope', text: `${outOfScope.length} compan${outOfScope.length === 1 ? 'y is' : 'ies are'} outside your access and not included.` });
  }

  const watermark: WatermarkMode = previewKeys.length ? 'preview' : unclosedShown.length ? 'preliminary' : 'none';
  const banner = previewKeys.length
    ? { tone: 'warn' as const, text: `Preview — not released. Partners and lenders don't see ${monthList(previewKeys)} yet.` }
    : null;

  const foot: string[] = [annotations[0].text];
  if (unclosedShown.length) foot.push(`${monthList(unclosedShown.map((p) => p.key))} ${unclosedShown.length === 1 ? 'is' : 'are'} preliminary.`);
  const restated = shown.filter((p) => p.restatedOn);
  if (restated.length) foot.push(`Restated: ${restated.map((p) => `${monthLabel(p.key)} (${dateLabel(p.restatedOn as string)})`).join(', ')}.`);
  if (previewKeys.length) foot.push('Includes months not yet released.');

  return {
    audience,
    includePreview,
    proForma,
    periods,
    shownPeriodKeys: shown.map((p) => p.key),
    locationsByPeriod,
    outOfScopeLocationIds: outOfScope,
    closedThrough: { scope: closedScope, byCompany: closedBy },
    releasedThrough: { scope: releasedScope, byCompany: releasedBy },
    watermark,
    banner,
    annotations,
    footnote: foot.join(' '),
  };
}

/** Distinct months on/before `through` that some scope company has not closed. */
function openEarlierCount(companies: CompanyFacts[], through: PeriodKey): number {
  const keys = new Set<PeriodKey>();
  for (const c of companies) for (const k of openBeforeClosed(c)) if (k < through) keys.add(k);
  return keys.size;
}

/** True when the period's status meets the auto-release minimum. */
export function meetsMinimum(status: CloseStatus, min: 'SOFT_CLOSE' | 'HARD_CLOSE'): boolean {
  return statusRank(status) >= statusRank(min);
}
