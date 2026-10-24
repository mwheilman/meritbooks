/**
 * Reporting calendar — the per-company × month release grid and the deadline tiles for the
 * /reporting-calendar admin page (FPB §18.4). PURE over GovernanceFacts.
 */

import { addMonths, monthRange, monthOf, periodKey } from './periods';
import { closedThrough, closeStatusFor, inGroup, manualReleaseBlock, releaseState, releasedThrough } from './policy';
import { deadlineTiles, type DeadlineTile } from './deadlines';
import type { CloseStatus, CompanyFacts, CompanyReleaseState, GovernanceFacts, PeriodKey, ReleaseSettings } from './types';

export type CellState =
  | 'released' //          explicit manual release
  | 'released_auto' //     released by the auto rule
  | 'ready' //             hard-closed, ended, not released — a person can release it
  | 'withdrawn' //         taken back
  | 'soft_close' //        soft-closed, ended, not released — releasable by hand (preliminary)
  | 'open'
  | 'not_ended'
  | 'no_period'
  | 'outside_group';

export interface CalendarCell {
  key: PeriodKey;
  state: CellState;
  closeStatus: CloseStatus;
  release: CompanyReleaseState;
  canRelease: boolean;
  canWithdraw: boolean;
  inGroup: boolean;
  restatedOn: string | null;
  restatementCount: number;
  unacknowledgedRestatements: number;
}

export interface CalendarRow {
  locationId: string;
  name: string;
  closedThrough: PeriodKey | null;
  releasedThrough: PeriodKey | null;
  inGroupFrom: string | null;
  inGroupUntil: string | null;
  settings: ReleaseSettings;
  hasOverride: boolean;
  cells: CalendarCell[];
  deadlines: DeadlineTile[];
}

export interface Calendar {
  months: PeriodKey[];
  rows: CalendarRow[];
  closedThrough: PeriodKey | null;
  releasedThrough: PeriodKey | null;
  tenantDeadlines: DeadlineTile[];
}

function cellFor(c: CompanyFacts, key: PeriodKey, today: string): CalendarCell {
  const release = releaseState(c, key, today);
  const status = closeStatusFor(c, key);
  const member = inGroup(c, key);
  const { year, month } = { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
  const rs = c.restatements.filter((r) => r.year === year && r.month === month);
  const block = manualReleaseBlock(c, key, today);
  let state: CellState;
  if (!member) state = 'outside_group';
  else if (release.released) state = release.mode === 'AUTO' ? 'released_auto' : 'released';
  else if (release.withdrawn) state = 'withdrawn';
  else if (block === 'no_period') state = 'no_period';
  else if (block === 'not_ended') state = 'not_ended';
  else if (block === 'open') state = 'open';
  else if (status === 'HARD_CLOSE') state = 'ready';
  else state = 'soft_close'; // SOFT_CLOSE, ended: releasable by hand
  return {
    key,
    state,
    closeStatus: status,
    release,
    canRelease: block === null && !(release.released && !release.derived),
    canWithdraw: release.released,
    inGroup: member,
    restatedOn: rs.map((r) => r.detectedAt.slice(0, 10)).sort().at(-1) ?? null,
    restatementCount: rs.length,
    unacknowledgedRestatements: rs.filter((r) => !r.acknowledged).length,
  };
}

/** Release date of the whole period for these companies (every month, every in-group company). */
function scopeReleasedOn(companies: CompanyFacts[], months: PeriodKey[], today: string): string | null {
  let latest: string | null = null;
  let any = false;
  for (const c of companies) {
    for (const k of months) {
      if (!inGroup(c, k)) continue;
      if (!c.periods.some((p) => periodKey(p.year, p.month) === k)) continue;
      any = true;
      const st = releaseState(c, k, today);
      if (!st.released || !st.releasedOn) return null;
      const d = st.releasedOn.slice(0, 10);
      if (!latest || d > latest) latest = d;
    }
  }
  return any ? latest : null;
}

function periodMonths(endKey: PeriodKey, cadence: 'monthly' | 'quarterly' | 'annual'): PeriodKey[] {
  const span = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  return monthRange(addMonths(endKey, -(span - 1)), endKey);
}

export function buildCalendar(facts: GovernanceFacts, opts: { today: string; months?: number }): Calendar {
  const overrides = new Set(facts.companyOverrides ?? []);
  const n = Math.min(Math.max(opts.months ?? 12, 1), 36);
  const last = monthOf(opts.today);
  const months = monthRange(addMonths(last, -(n - 1)), last);
  const companies = Object.values(facts.companies).sort((a, b) => a.name.localeCompare(b.name));
  const fy = companies[0]?.fiscalYearStartMonth ?? 1;

  const rows: CalendarRow[] = companies.map((c) => {
    const hasOverride = overrides.has(c.locationId);
    return {
      locationId: c.locationId,
      name: c.name,
      closedThrough: closedThrough(c),
      releasedThrough: releasedThrough(c, opts.today),
      inGroupFrom: c.coverage?.inGroupFrom ?? null,
      inGroupUntil: c.coverage?.inGroupUntil ?? null,
      settings: c.settings,
      hasOverride,
      cells: months.map((k) => cellFor(c, k, opts.today)),
      deadlines: hasOverride
        ? deadlineTiles(c.settings.deadlines, {
            today: opts.today,
            fyStartMonth: c.fiscalYearStartMonth,
            releasedOn: (pk, def) => scopeReleasedOn([c], periodMonths(pk, def.cadence), opts.today),
            exists: (pk) => c.periods.some((p) => periodKey(p.year, p.month) === pk),
          })
        : [],
    };
  });

  const tenantDeadlines = deadlineTiles(facts.tenantSettings.deadlines, {
    today: opts.today,
    fyStartMonth: fy,
    releasedOn: (pk, def) => scopeReleasedOn(companies, periodMonths(pk, def.cadence), opts.today),
    exists: (pk) => companies.some((c) => c.periods.some((p) => periodKey(p.year, p.month) === pk)),
  });

  const ct = rows.map((r) => r.closedThrough);
  const rt = rows.map((r) => r.releasedThrough);
  const minOf = (xs: Array<PeriodKey | null>): PeriodKey | null =>
    xs.length === 0 || xs.some((x) => x === null) ? null : (xs as PeriodKey[]).sort()[0];
  return { months, rows, closedThrough: minOf(ct), releasedThrough: minOf(rt), tenantDeadlines };
}
