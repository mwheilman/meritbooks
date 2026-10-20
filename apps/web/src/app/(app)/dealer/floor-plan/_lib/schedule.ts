/**
 * Curtailment schedule editor ↔ API (`curtailmentSchedule: [{after_days, pct_bps} | {after_days, amount_cents}]`).
 * Pure; mirrors the Zod `curtailmentRule` union in lib/validations/dealer.ts so the
 * form refuses exactly what the server would.
 */

import type { CurtailmentRule } from '@/lib/dealer/engine/notes';
import { centsToInput, pctToBps } from '@/lib/dealer/ui/format';

export const MAX_SCHEDULE_ROWS = 24;

export interface ScheduleDraftRow {
  key: string;
  afterDays: string;
  mode: 'pct' | 'amount';
  pct: string;
  amountCents: number | null;
}

export interface ScheduleValidation {
  rules: CurtailmentRule[];
  /** Per-row message keyed by draft `key`. */
  errors: Record<string, string>;
  ok: boolean;
}

let seq = 0;
export function newScheduleRow(partial: Partial<ScheduleDraftRow> = {}): ScheduleDraftRow {
  seq += 1;
  return { key: `r${Date.now().toString(36)}${seq}`, afterDays: '', mode: 'pct', pct: '', amountCents: null, ...partial };
}

/** Program jsonb → editable rows (malformed entries are skipped, never crash). */
export function rulesToDrafts(raw: unknown): ScheduleDraftRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleDraftRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const after = typeof o.after_days === 'number' ? String(o.after_days) : '';
    if (typeof o.pct_bps === 'number') out.push(newScheduleRow({ afterDays: after, mode: 'pct', pct: (o.pct_bps / 100).toString() }));
    else if (typeof o.amount_cents === 'number') out.push(newScheduleRow({ afterDays: after, mode: 'amount', amountCents: o.amount_cents }));
  }
  return out;
}

export function validateSchedule(rows: ScheduleDraftRow[]): ScheduleValidation {
  const errors: Record<string, string> = {};
  const rules: CurtailmentRule[] = [];
  const seen = new Set<number>();
  if (rows.length > MAX_SCHEDULE_ROWS) {
    errors[rows[MAX_SCHEDULE_ROWS].key] = `A schedule can have at most ${MAX_SCHEDULE_ROWS} steps.`;
  }
  for (const r of rows.slice(0, MAX_SCHEDULE_ROWS)) {
    const days = /^\d+$/.test(r.afterDays.trim()) ? Number(r.afterDays.trim()) : NaN;
    if (!Number.isInteger(days) || days <= 0) {
      errors[r.key] = 'Enter the number of days after flooring (a whole number above 0).';
      continue;
    }
    if (seen.has(days)) {
      errors[r.key] = `Another step is already due ${days} days after flooring.`;
      continue;
    }
    if (r.mode === 'pct') {
      const bps = pctToBps(r.pct);
      if (bps === null || bps < 1 || bps > 10_000) {
        errors[r.key] = 'Enter a percent of the original principal between 0.01 and 100.';
        continue;
      }
      rules.push({ after_days: days, pct_bps: bps });
    } else {
      if (r.amountCents === null || !Number.isInteger(r.amountCents) || r.amountCents <= 0) {
        errors[r.key] = 'Enter a dollar amount above zero.';
        continue;
      }
      rules.push({ after_days: days, amount_cents: r.amountCents });
    }
    seen.add(days);
  }
  rules.sort((a, b) => a.after_days - b.after_days);
  return { rules, errors, ok: Object.keys(errors).length === 0 };
}

/** One-line description of a stored schedule ("10% at 180 days, then 10% at 270"). */
export function describeSchedule(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return 'No curtailments';
  const parts: string[] = [];
  for (const r of [...raw].sort((a, b) => Number((a as CurtailmentRule).after_days) - Number((b as CurtailmentRule).after_days))) {
    const o = r as CurtailmentRule;
    if (typeof o.pct_bps === 'number') parts.push(`${trimPct(o.pct_bps)} at ${o.after_days} days`);
    else if (typeof o.amount_cents === 'number') parts.push(`$${centsToInput(o.amount_cents)} at ${o.after_days} days`);
  }
  return parts.length ? parts.join(', then ') : 'No curtailments';
}

function trimPct(bps: number): string {
  const s = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${s}%`;
}
