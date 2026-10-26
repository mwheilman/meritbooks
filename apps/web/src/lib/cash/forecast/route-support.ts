/**
 * Route plumbing for /api/cash/* (Wave 4C): permission, company scope (org + client scope), the
 * org's today, number governance, and one error → response mapping. SERVER ONLY.
 *
 *   view     cash.forecast:view   (legacy forecast:view)        forecast, scenarios, accuracy
 *   position cash.position:view   (legacy cash_position:view)   position, history, runway
 *   edit     cash.forecast:edit   (legacy forecast:edit)        scenarios, items, settings, lines, snapshot
 *
 * Governance (Wave 3D): GL-derived history is shown to a non-finance reader only for released months
 * (cumulative rule — a balance needs every month through it released). The forecast's opening
 * balance falls back to the bank-feed balance when the current month is not released to the reader.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePermission } from '@/lib/rbac/require-permission';
import { clientScopeBypass, filterLocationsToScope, loadClientScope } from '@/lib/rbac/client-scope';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { getOrgToday } from '@/lib/dates/org-today';
import { governRouteMonths, memoFactsLoader, resolveRouteAudience, type GovernanceInfo, type RouteGuardContext } from '@/lib/reports/governance/route-guard';
import { loadCompanies, type CompanyRow } from './load';
import type { OpeningBasis } from './service';

export type CashNeed = 'view' | 'position' | 'edit';

export interface CashRouteCtx {
  userId: string;
  orgId: string;
  supabase: SupabaseClient;
  /** Companies in the caller's scope (all of them, or the one asked for). */
  companies: CompanyRow[];
  /** Every company in the caller's scope (pickers, transfer recommendations). */
  allCompanies: CompanyRow[];
  locationId: string | null;
  today: string;
  /**
   * Security review H4 / M1: may the caller read or write ORG-WIDE (location_id NULL) cash rows —
   * the combined snapshot, org-wide scenarios and their levers? Only with all-clients scope (or
   * scope not enforced); mirrors core.client_scope_bypass(), fails closed (client-scope.ts).
   */
  scopeBypass: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cashError(e: unknown, where: string): NextResponse {
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
  const status = (e as { status?: number } | null)?.status;
  if (status === 404 || status === 409 || status === 422) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Request failed', code: status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR' }, { status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/violates check constraint/i.test(msg)) return NextResponse.json({ error: 'Some values are out of range.', code: 'VALIDATION_ERROR' }, { status: 422 });
  if (/duplicate key|unique/i.test(msg)) return NextResponse.json({ error: 'That name is already used.', code: 'CONFLICT' }, { status: 409 });
  // Generic body (the detail can carry SQL / schema text); the detail goes to the server log.
  console.error(`[cash] ${where}:`, e);
  return NextResponse.json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL_ERROR' }, { status: 500 });
}

const NEED: Record<CashNeed, { feature: string; action: 'view' | 'edit' }> = {
  view: { feature: 'forecast', action: 'view' },
  position: { feature: 'cash_position', action: 'view' },
  edit: { feature: 'forecast', action: 'edit' },
};

/**
 * Authorize + scope one request. Fails closed: no org → 403; bad id → 422; no permission → 403;
 * a company outside the org or the caller's client scope → 403.
 */
export async function cashRouteCtx(
  ctx: { userId: string; orgId: string | null; supabase: SupabaseClient },
  locationParam: string | null | undefined,
  need: CashNeed,
): Promise<CashRouteCtx | NextResponse> {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const locationId = locationParam && locationParam !== 'all' ? locationParam : null;
  if (locationId && !UUID.test(locationId)) return NextResponse.json({ error: 'Invalid company id.', code: 'VALIDATION_ERROR' }, { status: 422 });
  const { feature, action } = NEED[need];
  const perm = await requirePermission(ctx.userId, feature, action, { locationId, route: `cash:${need}` });
  if (!perm.ok) return perm.response;
  if (perm.orgId !== ctx.orgId) return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
  try {
    const rows = await loadCompanies(ctx.supabase, ctx.orgId);
    const scope = await loadClientScope({ supabase: ctx.supabase });
    const all = await filterLocationsToScope({ supabase: ctx.supabase }, rows, 'api', scope);
    let companies = all;
    if (locationId) {
      companies = all.filter((c) => c.id === locationId);
      if (!companies.length) return NextResponse.json({ error: 'That company is not in your scope.', code: 'FORBIDDEN' }, { status: 403 });
    }
    const today = await getOrgToday(ctx.supabase, ctx.orgId);
    return { userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase, companies, allCompanies: all, locationId, today, scopeBypass: clientScopeBypass(scope) };
  } catch (e) {
    return cashError(e, 'scope');
  }
}

/** The service-role writer, after the org pin + client-scope assert for the company the row lands on. */
export async function cashWriter(c: CashRouteCtx, locationIds: ReadonlyArray<string | null | undefined>, orgOnly: ReadonlyArray<string | null | undefined> = []): Promise<SupabaseClient> {
  await assertWriteScope(c.supabase, c.orgId, locationIds, { orgOnlyLocationIds: orgOnly });
  return serviceWriter();
}

/**
 * M1: an ORG-WIDE cash row (location_id NULL — an org-wide scenario or lever) applies to every
 * client, so only a caller with all-clients scope may create / change / remove one. Null when
 * allowed, else the 403 to return.
 */
export function requireOrgWide(c: CashRouteCtx, locationId: string | null | undefined): NextResponse | null {
  if (locationId) return null;
  if (c.scopeBypass) return null;
  return NextResponse.json(
    { error: 'Only someone with access to every company can change an all-companies scenario. Pick a company instead.', code: 'FORBIDDEN' },
    { status: 403 },
  );
}

export async function logEvent(writer: SupabaseClient, c: CashRouteCtx, kind: string, locationId: string | null, subjectId: string | null, meta: Record<string, unknown> = {}, note: string | null = null): Promise<void> {
  const { error } = await writer.from('cash_forecast_events').insert({ org_id: c.orgId, location_id: locationId, event_kind: kind, subject_id: subjectId, actor_user_id: c.userId, note, meta });
  if (error) console.warn('[cash] event log failed (non-fatal):', error.message);
}

export interface Governed {
  finance: boolean;
  openingBasis: OpeningBasis;
  /** Is the book balance at this date shown to the reader (cumulative rule)? */
  shownDate: (isoDate: string) => boolean;
  /** Is this week's GL activity shown (both its months released)? */
  shownWeek: (weekStart: string) => boolean;
  info: GovernanceInfo | null;
}

function monthKey(d: string): string {
  return d.slice(0, 7);
}

/** Months from `fromDate` to `toDate` inclusive ('YYYY-MM'). */
function monthsBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  let [y, m] = fromDate.slice(0, 7).split('-').map(Number);
  const [ey, em] = toDate.slice(0, 7).split('-').map(Number);
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 240) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Governance for the cash surfaces. Finance sees everything (preview). Non-finance: a book balance
 * at a date is shown only when every month through it is released (cumulative), activity in a week
 * only when its months are released.
 */
export async function governCash(c: CashRouteCtx, fromDate: string): Promise<Governed> {
  const govCtx: RouteGuardContext = { supabase: c.supabase, orgId: c.orgId, userId: c.userId, deps: { loadFacts: memoFactsLoader() } };
  govCtx.audience = await resolveRouteAudience(govCtx);
  const months = monthsBetween(fromDate, c.today);
  const ids = c.companies.map((x) => x.id);
  const cum = await governRouteMonths(govCtx, { months, locationIds: ids, cumulative: true });
  if (cum.finance) {
    return { finance: true, openingBasis: 'BOOK', shownDate: () => true, shownWeek: () => true, info: cum.info };
  }
  const flow = await governRouteMonths(govCtx, { months, locationIds: ids });
  const today = monthKey(c.today);
  return {
    finance: false,
    openingBasis: cum.isShown(today) ? 'BOOK' : 'BANK_FEED',
    shownDate: (d) => cum.isShown(monthKey(d)),
    shownWeek: (w) => {
      const end = new Date(Date.parse(w) + 6 * 86_400_000).toISOString().slice(0, 10);
      return flow.isShown(monthKey(w)) && flow.isShown(monthKey(end));
    },
    info: cum.info,
  };
}

export function scenarioParam(v: string | null | undefined): string | null {
  return v && v !== 'base' && UUID.test(v) ? v : null;
}
