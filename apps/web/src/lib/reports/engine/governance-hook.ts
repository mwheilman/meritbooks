/**
 * Governance call point (Wave 3D implements it). EVERY engine result passes through
 * `applyGovernance` before it leaves the server: release cut-off, books-closed-through,
 * restatement snapshot comparison, draft watermark (FEATURE-GAP-AUDIT §4.9).
 *
 * Wave 3A ships the IDENTITY implementation. 3D registers its implementation once at
 * module load (e.g. from `lib/reports/governance/index.ts`):
 *
 *   import { registerGovernance } from '@/lib/reports/engine/governance-hook';
 *   registerGovernance(async (view, ctx) => ({ ...view, governance: { ... } }));
 *
 * and `engine/adapter.ts` imports '@/lib/reports/governance', so the hook is installed
 * wherever the engine runs. In production an unregistered hook THROWS (fail closed); in
 * tests it is the identity. A governance implementation may
 * annotate (`view.governance`, warnings, column status) or withhold unreleased columns; it
 * must not alter released figures.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DateRange, DrillWindow, GroupWindow, ReportRequest, ReportResult } from './types';

export interface GovernanceContext {
  supabase: SupabaseClient;
  orgId: string;
  userId: string | null;
  request: ReportRequest;
  /** the caller may preview unreleased months (admin preview) */
  preview?: boolean;
}

export type GovernanceFn = (view: ReportResult, ctx: GovernanceContext) => Promise<ReportResult>;

let impl: GovernanceFn | null = null;

export function registerGovernance(fn: GovernanceFn | null): void {
  impl = fn;
}

/**
 * FAIL CLOSED in production: a figure must never leave the server ungoverned because the
 * implementation was not registered (a lost import). Outside production (unit / PGlite
 * tests) an unregistered hook is the identity, so the engine can be tested on its own.
 */
function missing(name: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Report governance is not installed (${name}) — refusing to return figures.`);
  }
}

export async function applyGovernance(view: ReportResult, ctx: GovernanceContext): Promise<ReportResult> {
  if (!impl) {
    missing('applyGovernance');
    return view;
  }
  return impl(view, ctx);
}

// ─── drill (the GL lines behind a cell) ──────────────────────────────────────

export interface DrillGovernanceRequest {
  companyIds: string[];
  range: DateRange;
  /** windows the client sent (they can only NARROW the lines) */
  windows?: Record<string, DrillWindow> | null;
}

export type DrillGovernanceContext = Omit<GovernanceContext, 'request'>;

/**
 * Decides, BEFORE any line is read, whether the caller may see the GL lines of these
 * companies × months (release cut-off) and which per-company in-group windows the drill MUST
 * apply. Throws (403 NOT_RELEASED) when a month in the range is not released for the caller.
 * Returns the windows to pass to the drill RPC (null = none).
 */
export type DrillGovernanceFn = (req: DrillGovernanceRequest, ctx: DrillGovernanceContext) => Promise<Record<string, DrillWindow> | null>;

let drillImpl: DrillGovernanceFn | null = null;

export function registerDrillGovernance(fn: DrillGovernanceFn | null): void {
  drillImpl = fn;
}

export async function governDrill(req: DrillGovernanceRequest, ctx: DrillGovernanceContext): Promise<Record<string, DrillWindow> | null> {
  if (!drillImpl) {
    missing('governDrill');
    return req.windows && Object.keys(req.windows).length ? req.windows : null;
  }
  return drillImpl(req, ctx);
}

// ─── membership (pre-acquisition exclusion) ──────────────────────────────────

export interface MembershipRequest {
  /** every month the report reads, 'YYYY-MM', ascending */
  months: string[];
  companyIds: string[];
  scopeKind: 'company' | 'combined' | 'consolidated';
}

/**
 * Decides, BEFORE aggregation, which companies' in-group windows apply to this caller and
 * scope (e.g. a combined view excludes a company's months before it joined the group; a
 * finance user reading one company sees its own books). null = no window applies.
 */
export type MembershipFn = (req: MembershipRequest, ctx: GovernanceContext) => Promise<Record<string, GroupWindow> | null>;

let membership: MembershipFn | null = null;

export function registerMembership(fn: MembershipFn | null): void {
  membership = fn;
}

export async function resolveMembership(req: MembershipRequest, ctx: GovernanceContext): Promise<Record<string, GroupWindow> | null> {
  if (!membership) missing('resolveMembership');
  if (!membership || req.companyIds.length === 0 || req.months.length === 0) return null;
  const w = await membership(req, ctx);
  return w && Object.keys(w).length ? w : null;
}
