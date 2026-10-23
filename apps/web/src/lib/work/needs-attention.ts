/**
 * NEEDS ATTENTION — the ONE counting service for "what is waiting on me".
 *
 * Before this, the home ("Also waiting", the four-step strip), the rail's Inbox badge
 * and the Inbox tabs each counted on their own: different tables, different status
 * values (the home asked gl_entries for a 'DRAFT' status the enum doesn't have, so
 * drafts were always 0), different caps (the Inbox read 100 rows per source), and —
 * the leak — the Inbox ignored the active client entirely, so a sandbox client's
 * Inbox listed every other client's items. Now every surface calls this module with
 * the same scope and gets the same numbers:
 *
 *   resolveWorkScope   → validates the requested client against the caller's client
 *                        scope SERVER-SIDE (lib/rbac/client-scope). Under `enforce`
 *                        an out-of-scope client is refused; shadow logs would_deny.
 *   loadNeedsAttention → the scoped item list (lib/inbox/collect) + its summary.
 *   summarizeWork      → PURE: counts by lane / type / source / client, derived from
 *                        the very items the Inbox lists, so a tab can never disagree
 *                        with its list, and the four lanes always sum to the total.
 *
 * Read-only. RLS (the caller's client) isolates the tenant; the client filter is a
 * sub-filter within it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  collectInbox,
  groupInboxItems,
  type Disposition,
  type InboxGroup,
  type InboxItem,
  type InboxItemType,
  type WorkLane,
  type WorkSource,
} from '@/lib/inbox/collect';
import {
  isClientInScope,
  loadClientScope,
  logClientScopeDenials,
  decideClientScope,
  type ClientScopeContext,
  type ClientScopeState,
} from '@/lib/rbac/client-scope';
import { fetchCoreMap } from '@/lib/stitch-core';
import { getOrgToday } from '@/lib/dates/org-today';

export type { WorkLane, WorkSource } from '@/lib/inbox/collect';

export const WORK_LANES: readonly WorkLane[] = ['approvals', 'exceptions', 'alerts', 'drafts'];

const WORK_SOURCES: readonly WorkSource[] = [
  'approval',
  'expense_report',
  'expense_policy',
  'bill_hold',
  'ai_proposal',
  'bank',
  'receipt',
  'cost',
  'obligation',
  'je_draft',
];

const ITEM_TYPES: readonly InboxItemType[] = ['APPROVAL', 'POLICY_BLOCK', 'ALERT', 'EXCEPTION', 'DRAFT'];

/** Default alert horizon (days) — the rail, the home and the Inbox's default all use it. */
export const DEFAULT_ALERT_HORIZON_DAYS = 30;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** What a surface is scoped to: one client, or every client the caller may see. */
export interface WorkScope {
  /** A core.locations id, or null for the all-clients context. */
  locationId: string | null;
  /** The caller's client scope (mode + assigned clients) — the DB's truth. */
  state: ClientScopeState;
}

export type WorkScopeResolution =
  | { ok: true; scope: WorkScope }
  | { ok: false; status: 400 | 403; error: string; code: 'INVALID_CLIENT' | 'CLIENT_OUT_OF_SCOPE' };

const LocationIdSchema = z.string().uuid();

/** Treat '', 'all' and absent as the all-clients context. */
export function normalizeRequestedClient(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (v === '' || v === 'all') return null;
  return v;
}

/** PURE decision — exported for tests. */
export function decideWorkScope(state: ClientScopeState, requested: string | null): WorkScopeResolution {
  if (requested === null) return { ok: true, scope: { locationId: null, state } };
  if (!LocationIdSchema.safeParse(requested).success) {
    return { ok: false, status: 400, error: 'That client id is not valid.', code: 'INVALID_CLIENT' };
  }
  const decision = decideClientScope(state, requested);
  if (!decision.allowed) {
    return { ok: false, status: 403, error: 'That client is outside your access.', code: 'CLIENT_OUT_OF_SCOPE' };
  }
  return { ok: true, scope: { locationId: requested, state } };
}

/**
 * Validate the requested client (a `location_id` query param or the active-company
 * cookie) against the caller's client scope. off → allowed; shadow → allowed and the
 * out-of-scope pick is logged would_deny; enforce → refused (403) and logged denied.
 */
export async function resolveWorkScope(ctx: ClientScopeContext, raw: string | null | undefined): Promise<WorkScopeResolution> {
  const state = await loadClientScope(ctx);
  const requested = normalizeRequestedClient(raw);
  const res = decideWorkScope(state, requested);
  if (requested && LocationIdSchema.safeParse(requested).success && !isClientInScope(state, requested)) {
    await logClientScopeDenials(ctx, state, [requested], 'api', { surface: 'inbox' });
  }
  return res;
}

/**
 * PURE: keep only the items a scope may show.
 *   one client  → that client's items only (organization-level items live in the
 *                 all-clients view, under "Organization");
 *   all clients → organization-level items + clients in scope. Out-of-scope clients
 *                 are dropped under `enforce` (RLS already hides them there) and
 *                 reported (for the shadow log) under `shadow`.
 */
export function scopeWorkItems<T extends { locationId: string | null }>(
  items: readonly T[],
  scope: WorkScope,
): { items: T[]; outOfScopeLocationIds: string[] } {
  const out = new Set<string>();
  const kept: T[] = [];
  for (const it of items) {
    if (scope.locationId) {
      if (it.locationId === scope.locationId) kept.push(it);
      continue;
    }
    if (it.locationId && !isClientInScope(scope.state, it.locationId) && scope.state.mode !== 'off') {
      out.add(it.locationId);
      if (scope.state.mode === 'enforce') continue;
    }
    kept.push(it);
  }
  return { items: kept, outOfScopeLocationIds: Array.from(out) };
}

// ---------------------------------------------------------------------------
// Counts (PURE)
// ---------------------------------------------------------------------------

export type LaneCounts = Record<WorkLane, number>;
export type SourceCounts = Record<WorkSource, number>;

export interface LocationCounts {
  total: number;
  lanes: LaneCounts;
  sources: SourceCounts;
}

export interface NeedsAttentionCounts {
  /** Everything waiting = approvals + exceptions + alerts + drafts. */
  total: number;
  byLane: LaneCounts;
  byType: Record<InboxItemType, number>;
  bySource: SourceCounts;
  /** Per client (core.locations id). Organization-level items are under ORG_LEVEL_KEY. */
  byLocation: Record<string, LocationCounts>;
  /** AI proposals by advisory disposition; `unscored` = no disposition recorded. */
  byDisposition: Record<Disposition, number> & { unscored: number };
  /** Any CRITICAL item (drives the rail's brick count). */
  critical: number;
}

/** Key under which organization-level (no client) items are counted in byLocation. */
export const ORG_LEVEL_KEY = 'org';

function zeroLanes(): LaneCounts {
  return { approvals: 0, exceptions: 0, alerts: 0, drafts: 0 };
}
function zeroSources(): SourceCounts {
  const s = {} as SourceCounts;
  for (const k of WORK_SOURCES) s[k] = 0;
  return s;
}

export function summarizeWork(items: readonly Pick<InboxItem, 'lane' | 'type' | 'source' | 'locationId' | 'disposition' | 'severity'>[]): NeedsAttentionCounts {
  const byLane = zeroLanes();
  const bySource = zeroSources();
  const byType = {} as Record<InboxItemType, number>;
  for (const t of ITEM_TYPES) byType[t] = 0;
  const byLocation: Record<string, LocationCounts> = {};
  const byDisposition = { AUTO: 0, REVIEW: 0, ESCALATE: 0, BLOCKED: 0, unscored: 0 };
  let critical = 0;

  for (const it of items) {
    byLane[it.lane] += 1;
    bySource[it.source] += 1;
    byType[it.type] += 1;
    if (it.severity === 'CRITICAL') critical += 1;
    if (it.source === 'ai_proposal') {
      if (it.disposition) byDisposition[it.disposition] += 1;
      else byDisposition.unscored += 1;
    }
    const key = it.locationId ?? ORG_LEVEL_KEY;
    const loc = (byLocation[key] ??= { total: 0, lanes: zeroLanes(), sources: zeroSources() });
    loc.total += 1;
    loc.lanes[it.lane] += 1;
    loc.sources[it.source] += 1;
  }

  return { total: items.length, byLane, byType, bySource, byLocation, byDisposition, critical };
}

/** Empty counts — the shape every surface renders before (or instead of) a load. */
export function emptyCounts(): NeedsAttentionCounts {
  return summarizeWork([]);
}

/** One client's counts (zeros when it has nothing waiting). */
export function countsForLocation(counts: NeedsAttentionCounts, locationId: string): LocationCounts {
  return counts.byLocation[locationId] ?? { total: 0, lanes: zeroLanes(), sources: zeroSources() };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** An Inbox item plus the client's display name (for the all-clients grouping). */
export interface WorkItem extends InboxItem {
  /** core.locations.name; null for organization-level items or an unresolved name. */
  locationName: string | null;
}

export interface LoadNeedsAttentionOptions {
  scope: WorkScope;
  /** yyyy-mm-dd; defaults to the ORG's calendar date (same as the home). */
  asOf?: string;
  alertHorizonDays?: number;
  /** Only changes severity (CRITICAL vs HIGH on approvals) — never the counts. */
  canApproveMoney?: boolean;
  /** Stitch client names onto items (lists need them; pure counts don't). Default true. */
  withNames?: boolean;
}

export interface NeedsAttentionResult {
  asOf: string;
  scope: { locationId: string | null; isAll: boolean };
  items: WorkItem[];
  groups: InboxGroup[];
  counts: NeedsAttentionCounts;
  degraded: string[];
}

export async function loadNeedsAttention(
  supabase: SupabaseClient,
  opts: LoadNeedsAttentionOptions,
): Promise<NeedsAttentionResult> {
  const asOf = opts.asOf ?? (await getOrgToday(supabase, null));
  const alertHorizonDays = opts.alertHorizonDays ?? DEFAULT_ALERT_HORIZON_DAYS;
  const collected = await collectInbox(supabase, {
    asOf,
    canApproveMoney: opts.canApproveMoney ?? false,
    alertHorizonDays,
    locationId: opts.scope.locationId,
  });

  const { items: scoped, outOfScopeLocationIds } = scopeWorkItems(collected.items, opts.scope);
  if (outOfScopeLocationIds.length > 0) {
    await logClientScopeDenials({ supabase }, opts.scope.state, outOfScopeLocationIds, 'api', { surface: 'inbox' });
  }

  let names = new Map<string, { id: string; name: string }>();
  if (opts.withNames !== false) {
    names = await fetchCoreMap<{ id: string; name: string }>(
      supabase,
      'locations',
      'id, name',
      scoped.map((i) => i.locationId),
    );
  }
  const items: WorkItem[] = scoped.map((i) => ({ ...i, locationName: i.locationId ? names.get(i.locationId)?.name ?? null : null }));

  return {
    asOf,
    scope: { locationId: opts.scope.locationId, isAll: opts.scope.locationId === null },
    items,
    groups: groupInboxItems(items),
    counts: summarizeWork(items),
    degraded: collected.degraded,
  };
}

// ---------------------------------------------------------------------------
// Exceptions-lane projection (the Exceptions tab's row shape)
// ---------------------------------------------------------------------------

export type ExceptionSource = 'bank' | 'receipt' | 'ai_proposal' | 'cost';

/** One Exceptions-tab row. `id` is the underlying record's id (what /api/exceptions/resolve takes). */
export interface ExceptionItem {
  id: string;
  source: ExceptionSource;
  title: string;
  subtitle: string | null;
  amountCents: number | null;
  confidence: number | null;
  disposition: Disposition | null;
  companyId: string | null;
  companyName: string | null;
  createdAt: string;
  href: string;
}

const EXCEPTION_SOURCE: Partial<Record<WorkSource, ExceptionSource>> = {
  ai_proposal: 'ai_proposal',
  bank: 'bank',
  receipt: 'receipt',
  cost: 'cost',
};

/** PURE: the exceptions lane, newest first, in the Exceptions-tab shape. */
export function toExceptionItems(items: readonly WorkItem[]): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  for (const i of items) {
    const source = i.lane === 'exceptions' ? EXCEPTION_SOURCE[i.source] : undefined;
    if (!source) continue;
    out.push({
      id: i.entity.id,
      source,
      title: i.title,
      subtitle: i.subtitle,
      amountCents: i.amountCents,
      confidence: i.confidence,
      disposition: i.disposition,
      companyId: i.locationId,
      companyName: i.locationName,
      createdAt: i.createdAt ?? '',
      href: i.actionHref,
    });
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

/**
 * Keep the first `cap` items of each lane (items arrive ranked) — a payload bound for
 * the list; counts are always computed over the full set first.
 */
export function capPerLane<T extends { lane: WorkLane }>(items: readonly T[], cap: number): { items: T[]; truncated: Record<WorkLane, boolean> } {
  const seen: LaneCounts = zeroLanes();
  const truncated: Record<WorkLane, boolean> = { approvals: false, exceptions: false, alerts: false, drafts: false };
  const out: T[] = [];
  for (const it of items) {
    if (seen[it.lane] < cap) {
      out.push(it);
      seen[it.lane] += 1;
    } else {
      truncated[it.lane] = true;
    }
  }
  return { items: out, truncated };
}

/** Counts only (the home + rail). Same collector, same scope — so the numbers agree. */
export async function countNeedsAttention(
  supabase: SupabaseClient,
  opts: Omit<LoadNeedsAttentionOptions, 'withNames'>,
): Promise<{ counts: NeedsAttentionCounts; degraded: string[]; asOf: string }> {
  const r = await loadNeedsAttention(supabase, { ...opts, withNames: false });
  return { counts: r.counts, degraded: r.degraded, asOf: r.asOf };
}
