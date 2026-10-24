/**
 * Number governance for compiled report packs (NL compiler, saved packs, scheduled email
 * delivery). Every (report × period) section is gated BEFORE its figures are read:
 *
 *   - income statement / sales by customer → every month of the window released;
 *   - cash flow → the window AND its beginning cash (cumulative rule);
 *   - balance sheet / trial balance → every month through the as-of month (cumulative);
 *   - A/R / A/P aging → a snapshot as of today (cumulative through today's month).
 *
 * The AUDIENCE is the reader's: an interactive download uses the signed-in user's
 * capabilities (finance sees preview, labelled); a scheduled / emailed delivery has NO user
 * and is always governed as NON-FINANCE — recipients are treated as partners, whoever
 * scheduled it. A withheld section carries no figures (a "not released" note), and the
 * scheduled path holds the whole delivery instead of sending a partial pack.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResolvedAudience } from '@/lib/reports/governance/audience';
import { monthList, monthOf } from '@/lib/reports/governance/periods';
import { governRouteMonths, rangeMonths, type GovernanceInfo, type RouteGuardDeps, type RouteGuardRequest } from '@/lib/reports/governance/route-guard';
import type { PeriodKey } from '@/lib/reports/governance/types';
import type { StatementModel } from '@/lib/reports/export/statement-model';
import type { ReportType, ResolvedPeriod } from './spec';

export interface PackGovernanceContext {
  /** The client the pack's figures are read with (RLS / org-scoped). */
  supabase: SupabaseClient;
  orgId: string;
  /** The signed-in reader; null = scheduled / emailed delivery → non-finance. */
  userId: string | null;
  audience?: ResolvedAudience;
  now?: Date;
  deps?: RouteGuardDeps;
}

export interface SectionGate {
  shown: boolean;
  /** Months withheld (empty when shown). */
  denied: PeriodKey[];
  info: GovernanceInfo | null;
}

/** The governance request a section needs (PURE). null = the period cannot be governed. */
export function sectionRequest(
  report: ReportType,
  period: Pick<ResolvedPeriod, 'startDate' | 'endDate' | 'asOfDate'>,
  locationIds: readonly string[],
  today: string,
): RouteGuardRequest | null {
  switch (report) {
    case 'INCOME_STATEMENT':
    case 'SALES_BY_CUSTOMER': {
      const months = rangeMonths(period.startDate, period.endDate);
      return months ? { months, locationIds } : null;
    }
    case 'CASH_FLOW': {
      const months = rangeMonths(period.startDate, period.endDate);
      return months ? { months, locationIds, cumulative: true } : null;
    }
    case 'BALANCE_SHEET':
    case 'TRIAL_BALANCE':
      return { months: [monthOf(period.asOfDate)], locationIds, cumulative: true };
    case 'AR_AGING':
    case 'AP_AGING':
      return { months: [monthOf(today)], locationIds, cumulative: true };
  }
}

/** Decide one section. Never throws for a governance reason (I/O errors propagate). */
export async function gateSection(
  ctx: PackGovernanceContext,
  report: ReportType,
  period: Pick<ResolvedPeriod, 'startDate' | 'endDate' | 'asOfDate'>,
  locationIds: readonly string[],
  today: string,
): Promise<SectionGate> {
  const req = sectionRequest(report, period, locationIds, today);
  const g = await governRouteMonths(
    { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, audience: ctx.audience, now: ctx.now, deps: ctx.deps },
    req ?? { months: [], locationIds },
  );
  if (!req) {
    // An ungovernable window (too long): finance passes, everyone else is withheld.
    return g.finance ? { shown: true, denied: [], info: g.info } : { shown: false, denied: [], info: g.info };
  }
  return { shown: g.deniedMonths.length === 0, denied: g.deniedMonths, info: g.info };
}

/** The no-figures stand-in for a withheld section. */
export function withheldModel(title: string, entityLabel: string, periodLabel: string, denied: readonly PeriodKey[], accent?: string): StatementModel {
  const which = denied.length ? `${monthList(denied.slice(0, 6))}${denied.length > 6 ? ' and more' : ''}` : 'This period';
  return {
    title,
    entityLabel,
    periodLabel,
    generatedAt: new Date().toISOString(),
    accent,
    columns: [{ key: 'status', label: 'Status' }],
    rows: [{ kind: 'note', label: `Not released — ${which} ${denied.length === 1 ? 'is' : 'are'} not released yet. Figures are withheld.`, values: [null] }],
    watermark: null,
    banner: 'Not released — figures withheld.',
    footnote: null,
  };
}

/** Stamp a shown section's model with the governance marks (server-side). */
export function stampGoverned(model: StatementModel, info: GovernanceInfo | null): StatementModel {
  if (!info) return model;
  return {
    ...model,
    watermark: info.watermark === 'preview' ? 'PREVIEW — NOT RELEASED' : info.watermark === 'preliminary' ? 'PRELIMINARY' : null,
    banner: info.banner?.text?.slice(0, 400) ?? null,
    footnote: info.footnote ? info.footnote.slice(0, 1200) : null,
  };
}

/** Why a compiled pack must not be emailed (any withheld section), or null (PURE). */
export function heldReason(compiled: { withheld: ReadonlyArray<{ report: string; periodLabel: string; periods: readonly PeriodKey[] }> }): string | null {
  if (!compiled.withheld.length) return null;
  const months = Array.from(new Set(compiled.withheld.flatMap((w) => w.periods))).sort();
  const what = compiled.withheld.map((w) => `${w.report} ${w.periodLabel}`).slice(0, 4).join(', ');
  return `not released${months.length ? ` (${months.slice(0, 6).join(', ')}${months.length > 6 ? ', …' : ''})` : ''}: ${what}${compiled.withheld.length > 4 ? ', …' : ''}`;
}
