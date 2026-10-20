/**
 * Service-role writer + org / client-scope pin for business tables that are SELECT-only
 * for members (migration 171, the 154 / 167 / 168 lock pattern).
 *
 * THE HOLE. Money / ledger / control tables (gl_entries, bills, bank_accounts, payment
 * batches, vendor bank details, portal tokens, …) carried `org_isolation FOR ALL` plus
 * INSERT / UPDATE / DELETE granted to `authenticated`, so any signed-in member could call
 * `/rest/v1/<table>` with their own JWT and bypass every route check and the capability
 * model. Migration 171 revokes member writes on those tables; the app writes them here.
 *
 * THE RULE for every write to a locked table:
 *   1. the route / service has ALREADY authorized the action (requirePermission /
 *      requireMoneyMovement / the approval engines' own gates) — unchanged by this module;
 *   2. the write goes through `serviceWriter()` (service role), never the caller's
 *      RLS-scoped client;
 *   3. `org_id` is the caller's session-resolved org — set on insert, `.eq('org_id', …)`
 *      on update / delete;
 *   4. because the service role bypasses RLS — including 163's RESTRICTIVE client-scope
 *      policy — every client (core.locations row) the write lands on is checked here:
 *      it must belong to the org, and (client_scope_rls_mode = enforce) be inside the
 *      caller's assignment scope. Shadow mode logs the would-be denial and allows.
 *
 * WHICH CLIENT WRITES (lib code that takes the caller's client): `writerFor` /
 * `scopedWriter` ESCALATE only a known member client (lib/supabase/member-client.ts) to the
 * service role — after the org / client-scope checks. Any other client (the service role
 * held by a drain / webhook / cron, a test fake) writes as itself, exactly as before; an
 * unknown member-scoped client is therefore refused by RLS, never silently upgraded.
 * Route code that knows it holds the member client calls `serviceWriter()` directly after
 * its own checks.
 *
 * The DB triggers that guard the ledger (balance, period lock 152, posted-GL immutability
 * 153, control accounts, dimension validation, entry numbering) are role-independent, so
 * they fire for service-role writes exactly as they did for member writes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { isMemberClient } from '@/lib/supabase/member-client';

export { isMemberClient };
import {
  decideClientScope,
  loadClientScope,
  logClientScopeDenials,
  type ClientScopeState,
} from '@/lib/rbac/client-scope';

/** A write refused because its target is outside the caller's org or client scope. */
export class WriteScopeError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'WriteScopeError';
  }
}

export function isWriteScopeError(e: unknown): e is WriteScopeError {
  return e instanceof WriteScopeError;
}

/** The service-role writer. Optional override for tests / callers that already hold one. */
export function serviceWriter(override?: SupabaseClient | null): SupabaseClient {
  return override ?? createAdminSupabase();
}

/**
 * The client a write to a member-locked table goes through, given the caller's client:
 * the service role for a known member client (callers MUST have run their permission
 * check and `assertWriteScope` / an RLS read of the row first), else the caller itself.
 */
export function writerFor(caller: SupabaseClient, override?: SupabaseClient | null): SupabaseClient {
  if (override) return override;
  return isMemberClient(caller) ? createAdminSupabase() : caller;
}

export interface WriteScopeOptions {
  /** Service-role client to verify org membership with (tests inject one). */
  writer?: SupabaseClient | null;
  /**
   * Reference-only clients (e.g. a GL line's counterparty_location_id): must belong to the
   * org, but are not owning rows, so client scope is not applied (same as 163's policy,
   * which never scoped on them).
   */
  orgOnlyLocationIds?: ReadonlyArray<string | null | undefined>;
}

// Per-request caches keyed by the caller's client (a fresh client is created per request).
const scopeCache = new WeakMap<SupabaseClient, Promise<ClientScopeState>>();
const verifiedCache = new WeakMap<SupabaseClient, Set<string>>();

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

function callerScope(caller: SupabaseClient): Promise<ClientScopeState> {
  let p = scopeCache.get(caller);
  if (!p) {
    p = loadClientScope({ supabase: caller });
    scopeCache.set(caller, p);
  }
  return p;
}

/**
 * Fail closed unless every client a write lands on belongs to `orgId` and — for owning
 * clients — is inside the caller's client scope (enforce mode). `caller` is the client
 * the request holds: the member's RLS client from a route, or the service role in a
 * drain / cron (whose scope is "everything", so only the org pin applies).
 */
export async function assertWriteScope(
  caller: SupabaseClient,
  orgId: string,
  locationIds: ReadonlyArray<string | null | undefined>,
  opts: WriteScopeOptions = {},
): Promise<void> {
  if (!orgId) throw new WriteScopeError('This write has no organization.');
  const owning = uniq(locationIds);
  const all = uniq([...owning, ...(opts.orgOnlyLocationIds ?? [])]);
  if (all.length === 0) return;

  // 1. Org pin (service role, so an RLS-visible decoy can't satisfy it).
  let verified = verifiedCache.get(caller);
  if (!verified) {
    verified = new Set<string>();
    verifiedCache.set(caller, verified);
  }
  const toCheck = all.filter((id) => !verified!.has(`${orgId}:${id}`));
  if (toCheck.length > 0) {
    const { data, error } = await serviceWriter(opts.writer)
      .schema('core').from('locations')
      .select('id')
      .eq('org_id', orgId)
      .in('id', toCheck);
    if (error) throw new WriteScopeError(`Could not verify the company: ${error.message}`);
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    for (const id of toCheck) {
      if (!found.has(id)) throw new WriteScopeError('That company is not part of this organization.');
      verified.add(`${orgId}:${id}`);
    }
  }

  // 2. Client scope on owning clients (163 semantics; off/shadow allow, enforce refuses).
  if (owning.length === 0) return;
  const state = await callerScope(caller);
  if (state.mode === 'off' || state.allClients) return;
  const outOfScope = owning.filter((id) => !decideClientScope(state, id).inScope);
  if (outOfScope.length === 0) return;
  await logClientScopeDenials({ supabase: caller }, state, outOfScope, 'api');
  if (state.mode === 'enforce') throw new WriteScopeError('You do not have access to that company.');
}

/**
 * `assertWriteScope` + `writerFor` in one step for lib code: when the caller is a member
 * client the clients are checked (org pin + client scope) and the service role returned;
 * a service-role / unknown caller is returned as-is (no privilege is added, so nothing to
 * check beyond what its own RLS — or the trusted server path — already enforces).
 */
export async function scopedWriter(
  caller: SupabaseClient,
  orgId: string,
  locationIds: ReadonlyArray<string | null | undefined>,
  opts: WriteScopeOptions = {},
): Promise<SupabaseClient> {
  if (isMemberClient(caller)) await assertWriteScope(caller, orgId, locationIds, opts);
  return writerFor(caller, opts.writer);
}

/** An org-owned table a write references by id (FKs never check the tenant). */
export interface OrgRef {
  schema?: 'public' | 'core';
  table: string;
  ids: ReadonlyArray<string | null | undefined>;
  /** Human label for the error ("vendor", "approval"). */
  label: string;
}

/**
 * Fail closed unless every referenced id exists in `orgId` (service-role read, so an id
 * from another tenant can never ride a service-role write in through a foreign key).
 */
export async function assertOrgRefs(
  orgId: string,
  refs: ReadonlyArray<OrgRef>,
  opts: Pick<WriteScopeOptions, 'writer'> & {
    /** The caller's client: the lookup runs through `writerFor(caller)` (service role for a member). */
    caller?: SupabaseClient;
  } = {},
): Promise<void> {
  if (!orgId) throw new WriteScopeError('This write has no organization.');
  for (const ref of refs) {
    const ids = uniq(ref.ids);
    if (ids.length === 0) continue;
    const w = opts.caller ? writerFor(opts.caller, opts.writer) : serviceWriter(opts.writer);
    const base = ref.schema === 'core' ? w.schema('core').from(ref.table) : w.from(ref.table);
    const { data, error } = await base.select('id').eq('org_id', orgId).in('id', ids);
    if (error) throw new WriteScopeError(`Could not verify the ${ref.label}: ${error.message}`);
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    if (ids.some((id) => !found.has(id))) {
      throw new WriteScopeError(`That ${ref.label} is not part of this organization.`);
    }
  }
}

/**
 * Load one org-owned row through `writerFor(caller)` (the service role for a member
 * caller), pinned to `orgId`, and — for a member caller — assert its owning client is in
 * the caller's org + client scope. Returns the row, or null when it does not exist
 * in the org (callers answer 404). For rows whose owning client lives in another column,
 * pass `locationColumn`; for org-level tables pass `locationColumn: null`.
 */
export async function loadWritableRow<T extends Record<string, unknown>>(
  caller: SupabaseClient,
  orgId: string,
  ref: { schema?: 'public' | 'core'; table: string; id: string; select?: string; locationColumn?: string | null },
  opts: WriteScopeOptions = {},
): Promise<T | null> {
  const w = writerFor(caller, opts.writer);
  const locCol = ref.locationColumn === undefined ? 'location_id' : ref.locationColumn;
  const cols = ref.select ?? (locCol ? `id, ${locCol}` : 'id');
  const base = ref.schema === 'core' ? w.schema('core').from(ref.table) : w.from(ref.table);
  const { data, error } = await base.select(cols).eq('id', ref.id).eq('org_id', orgId).maybeSingle();
  if (error) throw new Error(`Could not load ${ref.table}: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as T;
  if (locCol && isMemberClient(caller)) {
    const loc = row[locCol];
    await assertWriteScope(caller, orgId, [typeof loc === 'string' ? loc : null], opts);
  }
  return row;
}
