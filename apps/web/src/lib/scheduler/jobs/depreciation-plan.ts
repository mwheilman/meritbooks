/**
 * PURE previews for the month-end schedule jobs (close.depreciation, insurance.amortize):
 * "what WOULD the engine post through `asOf`?" — computed with the SAME pure schedule
 * builders the engines use (depreciation-methods, intangibles/amortization,
 * prepaid/schedule), so the preview and the post never disagree.
 *
 * Period locks: a period whose month is HARD_CLOSE for the company is never posted (the
 * GL trigger refuses it and the engine stops that asset's catch-up there). The preview
 * mirrors that exactly: it stops the asset at the first locked period and reports it.
 *
 * No I/O, no clock. All money is integer cents.
 */

import { buildDepreciationSchedule, isUnitsMethod, mapBookMethod, unitsProductionTarget } from '@/lib/posting/depreciation-methods';
import { buildIntangibleAmortizationSchedule } from '@/lib/intangibles/amortization';
import { isIntangibleCategory, isNonAmortizing } from '@/lib/intangibles/categories';
import { buildAmortizationSchedule } from '@/lib/prepaid/schedule';

/** 'location:YYYY-MM' → the month is HARD_CLOSE for that company. */
export type LockedPeriods = ReadonlySet<string>;

export function periodKey(locationId: string, year: number, month: number): string {
  return `${locationId}:${year}-${String(month).padStart(2, '0')}`;
}

function addMonths(start: string, n: number): { year: number; month: number } {
  const d = new Date(`${start}T00:00:00Z`);
  const base = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  return { year: Math.floor(base / 12), month: (base % 12) + 1 };
}

function monthsElapsed(start: string, asOf: string): number {
  const s = new Date(`${start}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  return (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth()) + 1;
}

export interface AssetForPlan {
  id: string;
  location_id: string;
  category: string | null;
  acquisition_date: string;
  acquisition_cost_cents: number;
  salvage_value_cents: number;
  useful_life_months: number;
  depreciation_method: string;
  accumulated_depreciation_cents: number;
  last_depreciation_date: string | null;
  total_expected_units?: number | string | null;
  units_used?: number | string | null;
}

export interface AssetPlan {
  assetId: string;
  locationId: string;
  kind: 'depreciation' | 'amortization';
  periods: number;
  amountCents: number;
  /** The catch-up stopped at a HARD_CLOSE month (that month and later wait). */
  blockedByLock: string | null;
  /** Not postable by the book engine (MACRS, goodwill, bad inputs) — reason. */
  skipped: string | null;
}

/** What runDepreciation / runAmortization WOULD post for one ACTIVE asset through `asOf`. */
export function planAsset(a: AssetForPlan, asOf: string, locked: LockedPeriods): AssetPlan {
  const intangible = isIntangibleCategory(a.category);
  const out: AssetPlan = {
    assetId: a.id, locationId: a.location_id, kind: intangible ? 'amortization' : 'depreciation',
    periods: 0, amountCents: 0, blockedByLock: null, skipped: null,
  };
  const cost = Number(a.acquisition_cost_cents);
  const salvage = Number(a.salvage_value_cents ?? 0);
  const base = cost - salvage;
  let accumulated = Number(a.accumulated_depreciation_cents ?? 0);

  if (isNonAmortizing(a.category)) return { ...out, skipped: 'goodwill / indefinite-lived (impairment only)' };
  if (base <= 0) return { ...out, skipped: 'no depreciable base' };

  // Units-of-production: one charge for the asOf month, driven by the meter.
  if (!intangible && isUnitsMethod(a.depreciation_method)) {
    const total = Number(a.total_expected_units);
    if (!(total > 0)) return { ...out, skipped: 'units-of-production asset has no total units' };
    let target: number;
    try {
      target = unitsProductionTarget(cost, salvage, total, Math.max(0, Number(a.units_used ?? 0)));
    } catch {
      return { ...out, skipped: 'units target could not be computed' };
    }
    const amount = target - accumulated;
    if (amount <= 0) return out;
    const at = new Date(`${asOf}T00:00:00Z`);
    const key = periodKey(a.location_id, at.getUTCFullYear(), at.getUTCMonth() + 1);
    if (locked.has(key)) return { ...out, blockedByLock: key.split(':')[1] };
    return { ...out, periods: 1, amountCents: amount };
  }

  let schedule: number[];
  try {
    if (intangible) {
      schedule = buildIntangibleAmortizationSchedule({
        category: a.category ?? '', costCents: cost, salvageCents: salvage, usefulLifeMonths: a.useful_life_months, method: a.depreciation_method,
      });
    } else {
      const mapped = mapBookMethod(a.depreciation_method);
      if (!mapped) return { ...out, skipped: `${a.depreciation_method} is a tax method (not posted to the books)` };
      if (a.useful_life_months <= 0) return { ...out, skipped: 'zero useful life' };
      schedule = buildDepreciationSchedule({
        costCents: cost, salvageCents: salvage, usefulLifeMonths: a.useful_life_months, method: mapped.method, decliningFactor: mapped.decliningFactor,
      });
    }
  } catch (e) {
    return { ...out, skipped: e instanceof Error ? e.message : 'schedule could not be built' };
  }

  const alreadyPosted = a.last_depreciation_date ? monthsElapsed(a.acquisition_date, a.last_depreciation_date) : 0;
  const due = Math.min(monthsElapsed(a.acquisition_date, asOf), a.useful_life_months);
  for (let idx = alreadyPosted; idx < due; idx++) {
    const remaining = base - accumulated;
    if (remaining <= 0) break;
    const amount = Math.min(schedule[idx] ?? 0, remaining);
    if (amount <= 0) continue;
    const { year, month } = addMonths(a.acquisition_date, idx);
    const key = periodKey(a.location_id, year, month);
    if (locked.has(key)) {
      out.blockedByLock = key.split(':')[1];
      break; // the engine stops this asset's catch-up at the locked month
    }
    out.periods++;
    out.amountCents += amount;
    accumulated += amount;
  }
  return out;
}

export interface ScheduleForPlan {
  id: string;
  location_id: string;
  total_cents: number | string;
  months: number;
  start_date: string;
  periods_posted: number;
}

export interface SchedulePlan {
  scheduleId: string;
  locationId: string;
  periods: number;
  amountCents: number;
  blockedByLock: string | null;
  skipped: string | null;
}

/** What runInsuranceAmortizations WOULD post for one ACTIVE schedule through `asOf`. */
export function planSchedule(s: ScheduleForPlan, asOf: string, locked: LockedPeriods): SchedulePlan {
  const out: SchedulePlan = { scheduleId: s.id, locationId: s.location_id, periods: 0, amountCents: 0, blockedByLock: null, skipped: null };
  let lines;
  try {
    lines = buildAmortizationSchedule({ totalCents: Number(s.total_cents), startDate: s.start_date, months: s.months });
  } catch (e) {
    return { ...out, skipped: e instanceof Error ? e.message : 'bad schedule' };
  }
  const d = new Date(`${asOf}T00:00:00Z`);
  const cutoff = d.getUTCFullYear() * 12 + d.getUTCMonth();
  for (let idx = s.periods_posted; idx < s.months; idx++) {
    const line = lines[idx];
    if (!line || line.year * 12 + (line.month - 1) > cutoff) break;
    const key = periodKey(s.location_id, line.year, line.month);
    if (locked.has(key)) {
      out.blockedByLock = key.split(':')[1];
      break;
    }
    out.periods++;
    out.amountCents += line.amountCents;
  }
  return out;
}

export interface CompanyRollup {
  locationId: string;
  periods: number;
  amountCents: number;
  items: number;
  blocked: number;
}

/** Roll plans up to one line per company (the "one entry per company" view the owner sees). */
export function rollupByCompany(plans: ReadonlyArray<{ locationId: string; periods: number; amountCents: number; blockedByLock: string | null }>): CompanyRollup[] {
  const by = new Map<string, CompanyRollup>();
  for (const p of plans) {
    const r = by.get(p.locationId) ?? { locationId: p.locationId, periods: 0, amountCents: 0, items: 0, blocked: 0 };
    if (p.periods > 0) {
      r.periods += p.periods;
      r.amountCents += p.amountCents;
      r.items++;
    }
    if (p.blockedByLock) r.blocked++;
    by.set(p.locationId, r);
  }
  return [...by.values()].filter((r) => r.periods > 0 || r.blocked > 0).sort((a, b) => b.amountCents - a.amountCents);
}
