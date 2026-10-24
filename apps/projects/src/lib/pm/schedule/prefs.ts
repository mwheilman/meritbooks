/**
 * Per-user Gantt preferences (zoom, toggles, field mode, column widths), remembered in this
 * browser. Storage can be missing or throw (private windows, blocked site data), so every read
 * and write is guarded and the defaults always render. Client-safe.
 */
import { ZOOMS } from './timeline';
import type { ScheduleView, Zoom } from './types';

export interface GanttPrefs {
  zoom: Zoom;
  critical: boolean;
  baseline: boolean;
  /** 56 px rows and targets for gloves and tablets. */
  field: boolean;
  /** Grid width in px (the splitter). */
  gridWidth: number;
  /** Per job, the view last used (else the job type's default). */
  views: Record<string, ScheduleView>;
}

export const DEFAULT_PREFS: GanttPrefs = { zoom: 'week', critical: false, baseline: false, field: false, gridWidth: 560, views: {} };

const KEY = 'mp.schedule.prefs.v1';

export function prefsKey(userId: string | null | undefined): string {
  return userId ? `${KEY}:${userId}` : KEY;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Parse stored JSON into prefs, dropping anything malformed. Pure (exported for tests). */
export function parsePrefs(raw: string | null): GanttPrefs {
  if (!raw) return { ...DEFAULT_PREFS, views: {} };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS, views: {} };
  }
  if (typeof v !== 'object' || v === null) return { ...DEFAULT_PREFS, views: {} };
  const o = v as Record<string, unknown>;
  const views: Record<string, ScheduleView> = {};
  if (typeof o.views === 'object' && o.views !== null) {
    for (const [k, x] of Object.entries(o.views as Record<string, unknown>)) if (x === 'gantt' || x === 'list') views[k] = x;
  }
  const gw = typeof o.gridWidth === 'number' && Number.isFinite(o.gridWidth) ? Math.min(1200, Math.max(240, o.gridWidth)) : DEFAULT_PREFS.gridWidth;
  return {
    zoom: (ZOOMS as readonly unknown[]).includes(o.zoom) ? (o.zoom as Zoom) : DEFAULT_PREFS.zoom,
    critical: typeof o.critical === 'boolean' ? o.critical : DEFAULT_PREFS.critical,
    baseline: typeof o.baseline === 'boolean' ? o.baseline : DEFAULT_PREFS.baseline,
    field: typeof o.field === 'boolean' ? o.field : DEFAULT_PREFS.field,
    gridWidth: gw,
    views,
  };
}

export function loadPrefs(userId: string | null | undefined): GanttPrefs {
  const s = storage();
  if (!s) return { ...DEFAULT_PREFS, views: {} };
  try {
    return parsePrefs(s.getItem(prefsKey(userId)));
  } catch {
    return { ...DEFAULT_PREFS, views: {} };
  }
}

export function savePrefs(userId: string | null | undefined, prefs: GanttPrefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch {
    // quota or blocked storage: the preference lasts this visit only
  }
}
