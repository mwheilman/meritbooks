/**
 * Timeline geometry and windowing for the Gantt: day ↔ pixel scale per zoom, the rows and days
 * a viewport shows (only those are drawn, so 2,000 tasks cost the same as 30), and the header
 * ticks. Pure; everything in UTC day numbers (calendar.ts).
 */
import { dayNum, isoOf } from './calendar';
import type { Zoom } from './types';

export const PX_PER_DAY: Readonly<Record<Zoom, number>> = { day: 28, week: 12, month: 3.5 };
export const ZOOMS: readonly Zoom[] = ['day', 'week', 'month'];

export interface Scale {
  /** Day number of x = 0. */
  origin: number;
  ppd: number;
  /** Day count across the whole timeline. */
  days: number;
}

/** The timeline span: the schedule's dates plus padding, always covering today. */
export function makeScale(dates: Iterable<string | null>, today: string, zoom: Zoom, padDays = 14): Scale {
  let lo = dayNum(today);
  let hi = lo;
  for (const d of dates) {
    if (!d) continue;
    const n = dayNum(d);
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  // start on a Monday so week ticks line up
  const startDow = new Date(lo * 86_400_000).getUTCDay();
  const origin = lo - padDays - ((startDow + 6) % 7);
  return { origin, ppd: PX_PER_DAY[zoom], days: hi - origin + padDays * 2 + 1 };
}

export function xOf(s: Scale, iso: string): number {
  return (dayNum(iso) - s.origin) * s.ppd;
}

/** The day under x (floor), as ISO. */
export function dayAt(s: Scale, x: number): string {
  return isoOf(s.origin + Math.floor(x / s.ppd));
}

export function widthPx(s: Scale): number {
  return Math.ceil(s.days * s.ppd);
}

/** A bar from its first to its last day, inclusive. */
export function barX(s: Scale, start: string, finish: string): { x: number; w: number } {
  const x = xOf(s, start);
  const w = Math.max((dayNum(finish) - dayNum(start) + 1) * s.ppd, 2);
  return { x, w };
}

export interface RowWindow {
  /** First row index drawn (inclusive). */
  start: number;
  /** Last row index drawn (exclusive). */
  end: number;
  /** px from the top of the body to the first drawn row. */
  offset: number;
}

/** Rows a viewport needs, with `overscan` rows either side. */
export function rowWindow(scrollTop: number, viewport: number, rowH: number, count: number, overscan = 8): RowWindow {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0, offset: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const visible = Math.ceil(Math.max(0, viewport) / rowH) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, offset: start * rowH };
}

/** Day numbers a viewport needs horizontally (inclusive), with overscan in px. */
export function dayWindow(s: Scale, scrollLeft: number, width: number, overscanPx = 400): { from: number; to: number } {
  const a = Math.max(0, scrollLeft - overscanPx);
  const b = scrollLeft + Math.max(0, width) + overscanPx;
  return { from: s.origin + Math.floor(a / s.ppd), to: s.origin + Math.ceil(b / s.ppd) };
}

/** Does [start, finish] overlap the day window? */
export function inDayWindow(w: { from: number; to: number }, start: string, finish: string): boolean {
  return dayNum(finish) >= w.from && dayNum(start) <= w.to;
}

export interface Tick {
  x: number;
  label: string;
  /** Major ticks (month starts / week starts) draw a full-height rule. */
  major: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Two header tiers for the visible window: top (months, or months+year) and bottom (days/weeks). */
export function ticks(s: Scale, zoom: Zoom, w: { from: number; to: number }): { top: Tick[]; bottom: Tick[] } {
  const top: Tick[] = [];
  const bottom: Tick[] = [];
  const from = Math.max(s.origin, w.from);
  const to = Math.min(s.origin + s.days, w.to);
  for (let n = from; n <= to; n++) {
    const d = new Date(n * 86_400_000);
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();
    const x = (n - s.origin) * s.ppd;
    // the window's first day gets a month label too, unless a month starts right after it
    const daysLeft = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime() / 86_400_000 - n;
    if (dom === 1 || (n === from && daysLeft * s.ppd > 72)) {
      top.push({ x, label: zoom === 'month' || d.getUTCMonth() === 0 || n === from ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()] as string, major: dom === 1 });
    }
    if (zoom === 'day') bottom.push({ x, label: String(dom), major: dow === 1 });
    else if (zoom === 'week' && dow === 1) bottom.push({ x, label: `${MONTHS[d.getUTCMonth()]} ${dom}`, major: true });
    else if (zoom === 'month' && dow === 1) bottom.push({ x, label: dom <= 7 ? '' : String(dom), major: false });
  }
  return { top, bottom };
}

/** Pixels per day that fit `weeks` weeks into `width` px (print: "fit to N weeks"). */
export function fitPpd(width: number, weeks: number): number {
  return Math.max(1, width / Math.max(1, weeks * 7));
}
