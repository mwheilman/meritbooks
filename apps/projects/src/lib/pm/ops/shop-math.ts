/**
 * Work-center load as a capacity statement (pm.v_work_center_load): open standard minutes on
 * pending/ready/running operations of live production orders against weekly capacity. The
 * shop-wide figure matches shop_backlog_weeks: Σ open ÷ Σ capacity of ACTIVE centers. Pure.
 */
import type { WorkCenterLoadRow } from './types';

export function hoursText(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${h === 1 ? 'hour' : 'hours'}`;
}

export function weeksText(w: number): string {
  const r = Math.round(w * 10) / 10;
  return `${r.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${r === 1 ? 'week' : 'weeks'}`;
}

/** "CNC router: 46.5 hours open against 40 hours a week, 1.2 weeks of work." */
export function centerSentence(c: WorkCenterLoadRow): string {
  if (c.status === 'INACTIVE') return `${c.name} is not in use.`;
  if (c.capacity_minutes_per_week <= 0) return `${c.name}: ${hoursText(c.open_std_minutes)} open, and no weekly capacity set.`;
  const weeks = c.open_std_minutes / c.capacity_minutes_per_week;
  const down = c.status === 'DOWN' ? ' It is down for maintenance.' : '';
  if (c.open_std_minutes === 0) return `${c.name}: nothing open against ${hoursText(c.capacity_minutes_per_week)} a week.${down}`;
  return `${c.name}: ${hoursText(c.open_std_minutes)} open against ${hoursText(c.capacity_minutes_per_week)} a week, ${weeksText(weeks)} of work.${down}`;
}

export interface ShopLoad {
  openMinutes: number;
  capacityMinutes: number;
  weeks: number | null;
  /** The busiest active center (the constraint). */
  constraint: WorkCenterLoadRow | null;
  sentence: string;
}

export function shopLoad(rows: ReadonlyArray<WorkCenterLoadRow>): ShopLoad {
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const openMinutes = active.reduce((s, r) => s + r.open_std_minutes, 0);
  const capacityMinutes = active.reduce((s, r) => s + r.capacity_minutes_per_week, 0);
  const weeks = capacityMinutes > 0 ? openMinutes / capacityMinutes : null;
  const constraint = [...active].filter((r) => r.capacity_minutes_per_week > 0).sort((a, b) => b.open_std_minutes / b.capacity_minutes_per_week - a.open_std_minutes / a.capacity_minutes_per_week)[0] ?? null;
  let sentence: string;
  if (!rows.length) sentence = 'No work centers are set up yet.';
  else if (weeks == null) sentence = 'No running work center has weekly capacity set.';
  else if (openMinutes === 0) sentence = `The shop is clear: ${hoursText(capacityMinutes)} of capacity a week and nothing open.`;
  else {
    const cw = constraint ? constraint.open_std_minutes / constraint.capacity_minutes_per_week : 0;
    sentence = `The shop holds ${weeksText(weeks)} of released and sold work (${hoursText(openMinutes)} against ${hoursText(capacityMinutes)} a week).${constraint && cw > weeks * 1.2 ? ` ${constraint.name} is the constraint at ${weeksText(cw)}.` : ''}`;
  }
  return { openMinutes, capacityMinutes, weeks, constraint, sentence };
}
