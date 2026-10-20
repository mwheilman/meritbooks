/**
 * Client scope (IA M-4 v2 · 05-RBAC-SPEC §1.4 / §3.1 / §5.2.1) — app side of migration 163.
 *
 * WHO MAY SEE WHICH CLIENT. A client is a `core.locations` row. A member's client scope is
 * the union of their active, in-effect `core.access_assignments` (all_clients · client ·
 * client_set). The database computes it (`core.accessible_location_ids()`,
 * `core.can_access_location()`), so this module never re-derives it — it asks.
 *
 * STAGING (`core.organizations.client_scope_rls_mode`):
 *   off     → nothing changes (the DB policies pass everything the org policy passes, and
 *             this module allows everything);
 *   shadow  → still allowed, but every out-of-scope client a surface would have shown or
 *             selected is recorded as `would_deny` in `core.client_scope_shadow_log`
 *             (the DB cannot log on SELECT, so shadow logging lives here);
 *   enforce → the restrictive RLS filters rows; this module additionally refuses an
 *             out-of-scope active company and logs `denied`.
 *
 * FAIL-SAFE. If the scope RPC is unavailable (e.g. migration 163 not yet applied) the
 * state degrades to `off` — the app behaves exactly as before. That never weakens
 * `enforce`: the database policies are the guarantor; this module is the UX layer that
 * keeps the company switcher honest and produces the shadow evidence.
 *
 * Everything here runs on the caller's RLS-scoped client (identity, org and mode come
 * from the JWT inside the SECURITY DEFINER functions — the app never asserts them).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type ClientScopeMode = 'off' | 'shadow' | 'enforce';

/** Where a scope decision was taken — must match core.client_scope_shadow_log's CHECK. */
export type ClientScopeSurface = 'company_list' | 'active_company' | 'company_switch' | 'api';

/** Anything carrying the caller's RLS-scoped client (ApiContext satisfies this). */
export interface ClientScopeContext {
  supabase: SupabaseClient;
}

export interface ClientScopeState {
  mode: ClientScopeMode;
  /** The caller's active membership in the request org (null = no seat → no clients). */
  membershipId: string | null;
  /** Holds an `all_clients` assignment — every client of the tenant is in scope. */
  allClients: boolean;
  /** Clients in scope (the DB's truth; independent of mode). */
  locationIds: ReadonlySet<string>;
}

export interface ClientScopeDecision {
  /** May the surface proceed with this client? (Only `enforce` ever says no.) */
  allowed: boolean;
  /** Is the client inside the caller's assignment scope, regardless of mode? */
  inScope: boolean;
  mode: ClientScopeMode;
}

/** The degraded state: identical to pre-163 behaviour. */
export const CLIENT_SCOPE_OFF: ClientScopeState = Object.freeze({
  mode: 'off',
  membershipId: null,
  allClients: false,
  locationIds: new Set<string>(),
}) as ClientScopeState;

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'enforce']);

/** Parse `core.client_scope_state()`'s jsonb. Unknown shapes → null (caller degrades to off). */
export function parseClientScopeState(raw: unknown): ClientScopeState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.mode !== 'string' || !MODES.has(r.mode)) return null;
  const ids = Array.isArray(r.location_ids) ? r.location_ids.filter((x): x is string => typeof x === 'string') : [];
  return {
    mode: r.mode as ClientScopeMode,
    membershipId: typeof r.membership_id === 'string' ? r.membership_id : null,
    allClients: r.all_clients === true,
    locationIds: new Set(ids),
  };
}

/** One round-trip: mode + the caller's scope. Never throws; degrades to `off`. */
export async function loadClientScope(ctx: ClientScopeContext): Promise<ClientScopeState> {
  try {
    const { data, error } = await ctx.supabase.schema('core').rpc('client_scope_state');
    if (error) return CLIENT_SCOPE_OFF;
    return parseClientScopeState(data) ?? CLIENT_SCOPE_OFF;
  } catch {
    return CLIENT_SCOPE_OFF;
  }
}

/** Is this client inside the caller's scope? Org-level (null) is always in scope. */
export function isClientInScope(state: ClientScopeState, locationId: string | null | undefined): boolean {
  if (!locationId) return true;
  return state.allClients || state.locationIds.has(locationId);
}

/** Pure decision for one client under the state's mode. */
export function decideClientScope(state: ClientScopeState, locationId: string | null | undefined): ClientScopeDecision {
  const inScope = isClientInScope(state, locationId);
  return { allowed: state.mode === 'enforce' ? inScope : true, inScope, mode: state.mode };
}

/**
 * Record out-of-scope clients a surface touched (shadow → would_deny, enforce → denied).
 * The DB re-checks every id against the caller's real scope and tenant, so a caller can't
 * forge entries for other people or other tenants; repeats fold into one row per day.
 * Best-effort — logging never breaks the request.
 */
export async function logClientScopeDenials(
  ctx: ClientScopeContext,
  state: ClientScopeState,
  locationIds: readonly string[],
  surface: ClientScopeSurface,
  detail?: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (state.mode === 'off' || state.allClients) return;
  const out = Array.from(new Set(locationIds.filter((id) => id && !isClientInScope(state, id))));
  if (out.length === 0) return;
  try {
    await ctx.supabase.schema('core').rpc('log_client_scope_denials', {
      p_location_ids: out,
      p_surface: surface,
      p_detail: detail ?? null,
    });
  } catch {
    /* best-effort: the shadow log is evidence, not a control */
  }
}

/** The caller's clients in scope (the DB's truth, independent of mode). */
export async function accessibleLocationIds(ctx: ClientScopeContext, state?: ClientScopeState): Promise<string[]> {
  const s = state ?? (await loadClientScope(ctx));
  return Array.from(s.locationIds);
}

/**
 * Gate one client for a surface (active company, a list filter, a route param).
 * off → allowed; shadow → allowed + `would_deny` logged when out of scope;
 * enforce → refused + `denied` logged when out of scope.
 */
export async function assertClientInScope(
  ctx: ClientScopeContext,
  locationId: string | null | undefined,
  surface: ClientScopeSurface,
  state?: ClientScopeState,
): Promise<ClientScopeDecision> {
  const s = state ?? (await loadClientScope(ctx));
  const decision = decideClientScope(s, locationId);
  if (!decision.inScope && locationId) await logClientScopeDenials(ctx, s, [locationId], surface);
  return decision;
}

/**
 * Filter a list of clients (e.g. the company switcher's options) to the caller's scope.
 * off/shadow → the list is returned unchanged (shadow logs what enforce would drop);
 * enforce → out-of-scope clients are removed (and logged).
 */
export async function filterLocationsToScope<T extends { id: string }>(
  ctx: ClientScopeContext,
  rows: readonly T[],
  surface: ClientScopeSurface,
  state?: ClientScopeState,
): Promise<T[]> {
  const s = state ?? (await loadClientScope(ctx));
  if (s.mode === 'off') return [...rows];
  const outOfScope = rows.filter((r) => !isClientInScope(s, r.id)).map((r) => r.id);
  if (outOfScope.length > 0) await logClientScopeDenials(ctx, s, outOfScope, surface);
  return s.mode === 'enforce' ? rows.filter((r) => isClientInScope(s, r.id)) : [...rows];
}
