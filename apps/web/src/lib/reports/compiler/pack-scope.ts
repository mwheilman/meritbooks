/**
 * Report-pack client scope (security review H3). SERVER ONLY.
 *
 * A saved pack is rendered by the scheduler with a SYSTEM tenant client (every company) and
 * emailed to outside recipients, so the companies it names are what leaves the building:
 *   - `report_packs.location_ids`        the statements' companies (empty = all, consolidated);
 *   - `report_packs.fpna_items[].companies` each FP&A dashboard's companies (empty = all).
 *
 * WRITE (assertPackWriteScope): every named company must be in the org and in the caller's client
 * scope (assertWriteScope); an all-companies pack or dashboard needs all-clients scope
 * (clientScopeBypass). Members are SELECT-only on report_packs (191 §2b); the routes write with the
 * service role after this check.
 *
 * DELIVERY (packCreatorScope / itemWithinPack): the scheduler re-checks at send time, because a
 * scope can shrink after the pack was saved — the pack's creator must STILL cover the companies
 * (an all-companies pack: still all-clients), and a dashboard renders only when its companies sit
 * inside the pack's (an all-companies pack: any). Otherwise the pack / dashboard is skipped with a
 * logged reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWriteScope, WriteScopeError } from '@/lib/db/scoped-writer';
import { clientScopeBypass, loadClientScope } from '@/lib/rbac/client-scope';
import type { PackItem } from '@/lib/fpna/workspace/pack-items';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pack's company ids (validated strings only). */
export function packLocationIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

export interface PackCompanySet {
  /** Every company named by the pack or any of its dashboards. */
  ids: string[];
  /** Does the pack (or one of its dashboards) cover ALL companies? */
  orgWide: boolean;
}

export function packCompanySet(locationIds: unknown, items: ReadonlyArray<Pick<PackItem, 'companies'>>): PackCompanySet {
  const packIds = packLocationIds(locationIds);
  const ids = new Set(packIds);
  let orgWide = packIds.length === 0;
  for (const it of items) {
    if (it.companies.length === 0) orgWide = true;
    for (const c of it.companies) ids.add(c);
  }
  return { ids: Array.from(ids), orgWide };
}

/**
 * Fail closed (WriteScopeError → 403) unless the caller may save a pack naming these companies.
 * `caller` is the member's RLS client (scope + org pin come from it).
 */
export async function assertPackWriteScope(
  caller: SupabaseClient,
  orgId: string,
  locationIds: unknown,
  items: ReadonlyArray<Pick<PackItem, 'companies'>>,
  opts: { writer?: SupabaseClient | null } = {},
): Promise<void> {
  const set = packCompanySet(locationIds, items);
  const bad = set.ids.filter((id) => !UUID.test(id));
  if (bad.length) throw new WriteScopeError('That company is not part of this organization.');
  if (set.orgWide) {
    const state = await loadClientScope({ supabase: caller });
    if (!clientScopeBypass(state)) {
      throw new WriteScopeError('Only someone with access to every company can save an all-companies pack. Choose the companies instead.');
    }
  }
  await assertWriteScope(caller, orgId, set.ids, { writer: opts.writer });
}

/** Is a dashboard inside its pack? (all-companies pack → any; else item ⊆ pack, never "all"). */
export function itemWithinPack(itemCompanies: readonly string[], packLocations: unknown): boolean {
  const pack = packLocationIds(packLocations);
  if (pack.length === 0) return true;
  if (itemCompanies.length === 0) return false;
  const allowed = new Set(pack);
  return itemCompanies.every((c) => allowed.has(c));
}

export type CreatorScope = { ok: true } | { ok: false; reason: string };

interface AssignmentRow {
  scope_type: string;
  location_id: string | null;
  client_set_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
}

/**
 * Does the pack's creator CURRENTLY cover the pack's companies? Service-role reads (the scheduler
 * has no user session), the same rules as core.accessible_location_ids() (163): active membership,
 * active in-effect assignments, all_clients · client · client_set. Scope not enforced for the
 * tenant → covered (pre-163 behaviour). A read error fails closed.
 */
export async function packCreatorScope(
  admin: SupabaseClient,
  orgId: string,
  createdBy: string | null,
  locationIds: readonly string[],
  now: Date = new Date(),
): Promise<CreatorScope> {
  const org = await admin.schema('core').from('organizations').select('client_scope_rls_mode').eq('id', orgId).maybeSingle();
  if (org.error) return { ok: false, reason: 'could not read the client-scope mode' };
  const mode = String((org.data as { client_scope_rls_mode?: string } | null)?.client_scope_rls_mode ?? 'off');
  if (mode !== 'enforce') return { ok: true };
  if (!createdBy) return { ok: false, reason: 'the pack has no recorded creator, so its client scope cannot be checked' };

  const user = await admin.schema('core').from('users').select('id').eq('clerk_user_id', createdBy).maybeSingle();
  if (user.error) return { ok: false, reason: 'could not read the pack creator' };
  const userId = (user.data as { id?: string } | null)?.id;
  if (!userId) return { ok: false, reason: 'the pack creator is no longer a user' };
  const ms = await admin.schema('core').from('memberships').select('id').eq('org_id', orgId).eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (ms.error) return { ok: false, reason: 'could not read the pack creator’s membership' };
  const membershipId = (ms.data as { id?: string } | null)?.id;
  if (!membershipId) return { ok: false, reason: 'the pack creator no longer has an active seat' };

  const asg = await admin
    .schema('core')
    .from('access_assignments')
    .select('scope_type, location_id, client_set_id, effective_from, effective_to')
    .eq('org_id', orgId)
    .eq('membership_id', membershipId)
    .eq('status', 'active')
    .in('scope_type', ['all_clients', 'client', 'client_set']);
  if (asg.error) return { ok: false, reason: 'could not read the pack creator’s client scope' };
  const t = now.getTime();
  const live = ((asg.data ?? []) as AssignmentRow[]).filter(
    (a) => (!a.effective_from || Date.parse(a.effective_from) <= t) && (!a.effective_to || Date.parse(a.effective_to) > t),
  );
  if (live.some((a) => a.scope_type === 'all_clients')) return { ok: true };
  if (locationIds.length === 0) return { ok: false, reason: 'an all-companies pack needs its creator to have access to every company' };

  const covered = new Set(live.filter((a) => a.scope_type === 'client' && a.location_id).map((a) => a.location_id as string));
  const setIds = live.filter((a) => a.scope_type === 'client_set' && a.client_set_id).map((a) => a.client_set_id as string);
  if (setIds.length) {
    const members = await admin.schema('core').from('client_set_members').select('location_id').in('set_id', setIds);
    if (members.error) return { ok: false, reason: 'could not read the pack creator’s client sets' };
    for (const m of (members.data ?? []) as Array<{ location_id: string }>) covered.add(m.location_id);
  }
  const missing = locationIds.filter((id) => !covered.has(id));
  return missing.length === 0 ? { ok: true } : { ok: false, reason: `the pack creator no longer has access to ${missing.length} of its compan${missing.length === 1 ? 'y' : 'ies'}` };
}
