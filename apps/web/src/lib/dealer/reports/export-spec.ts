/**
 * Glue between the dealer reports and the existing reports system (report viewer
 * + export menu). Pure and client-safe. Both the embedded viewer panel and the
 * export spec build their request with `dealerReportParams`, so the exported file
 * is always the report on screen.
 */

import type { StatementModel } from '@/lib/reports/export/statement-model';
import { dealerReportDef, isDealerReportKey, type DealerReportKey } from './catalog';

/** The one client a dealer report runs for: exactly one selected id, else null. */
export function singleClient(locIds: string | string[] | null | undefined): string | null {
  const list = (Array.isArray(locIds) ? locIds : (locIds ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : null;
}

function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Query for GET /api/dealer/reports. Point-in-time reports take the period end as
 * the as-of date, never later than today (a month-end in the future would age
 * receivables to a date that hasn't happened).
 */
export function dealerReportParams(
  key: DealerReportKey,
  c: { locationId: string; sd?: string; ed?: string; today?: string },
): Record<string, string> {
  const today = c.today ?? localToday();
  const out: Record<string, string> = { report: key, locationId: c.locationId };
  if (dealerReportDef(key).mode === 'asOf') {
    out.asOf = c.ed && c.ed < today ? c.ed : today;
  } else {
    if (c.sd) out.start = c.sd;
    if (c.ed) out.end = c.ed;
  }
  return out;
}

export interface DealerExportMeta {
  reportLabel?: string;
  entityLabel?: string;
  periodLabel?: string;
  basisLabel?: string;
  accent?: string;
}

/**
 * The /api/dealer/reports payload (`{ data: { report, model } }`) → the model to
 * export. The server's period label is kept (it states the exact window used);
 * the viewer's title, entity and accent are applied.
 */
export function dealerModelFromPayload(payload: unknown, meta: DealerExportMeta): StatementModel {
  const model = (payload as { data?: { model?: StatementModel } } | null)?.data?.model;
  if (!model || !Array.isArray(model.rows) || !Array.isArray(model.columns)) {
    throw new Error('The dealer report did not return any data.');
  }
  return {
    ...model,
    title: meta.reportLabel || model.title,
    entityLabel: model.entityLabel || meta.entityLabel || '',
    periodLabel: model.periodLabel || meta.periodLabel || '',
    ...(meta.basisLabel ? { basisLabel: meta.basisLabel } : {}),
    accent: meta.accent ?? model.accent,
  };
}

export { isDealerReportKey };
