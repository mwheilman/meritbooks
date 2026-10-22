import 'server-only';
/**
 * getAccess() — the caller's Projects access for this request (spec §4). Cached per request.
 *
 * Built from ONE grants RPC, pm.my_access() (migration 1110; row shape = AccessRow), plus the
 * caller's membership id (core.rbac_caller_membership_id, mig 164) and, for the title, the
 * company's installed pack. Runs on the RLS client as the user — never service role.
 *
 * Fails closed: no session, or the RPC erroring/missing, yields an Access with no grants, so
 * every guarded route answers 403 rather than guessing.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getPack, getPackInput } from '@meritbooks/industry-packs';
import { getDb, getTenant } from '@/lib/tenant';
import { listInstalls } from '@/lib/pm/config';
import { buildAccess, emptyAccess, grantsByCompany } from './derive';
import { packRoleTitle } from './titles';
import type { Access, AccessRow, PersonaKey } from './types';

/** Preview-as cookie (owners only): value = PersonaKey. */
export const PREVIEW_COOKIE = 'mp_preview';

function toRows(data: unknown): AccessRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is AccessRow =>
    typeof r === 'object' && r !== null
    && typeof (r as AccessRow).location_id === 'string'
    && typeof (r as AccessRow).capability === 'string'
    && Array.isArray((r as AccessRow).actions));
}

/** Title from the pack of the company the caller is working in (display only — never throws). */
async function loadTitleResolver(companyId: string | null): Promise<(p: PersonaKey) => string | null> {
  if (!companyId) return () => null;
  try {
    const db = await getDb();
    if (!db) return () => null;
    const [install] = await listInstalls(db, [companyId]);
    if (!install) return () => null;
    const manifest = getPack(install.pack_key, install.pack_version) ?? getPack(install.pack_key);
    const input = getPackInput(install.pack_key, install.pack_version) ?? getPackInput(install.pack_key);
    return (p) => packRoleTitle(manifest, p) ?? packRoleTitle(input, p);
  } catch {
    return () => null;
  }
}

interface AccessInputs {
  rows: AccessRow[];
  membershipId: string | null;
  titleFor: (p: PersonaKey) => string | null;
}

/** The one RPC round (plus membership + title), shared by getAccess and getRealAccess. */
const loadAccessInputs = cache(async (): Promise<AccessInputs | null> => {
  const db = await getDb();
  if (!db) return null;

  const [grantsRes, memberRes] = await Promise.all([
    db.schema('pm').rpc('my_access'),
    db.schema('core').rpc('rbac_caller_membership_id'),
  ]);
  const membershipId = typeof memberRes.data === 'string' ? memberRes.data : null;
  if (grantsRes.error) {
    // eslint-disable-next-line no-console
    console.error('[projects access] pm.my_access failed; denying by default', grantsRes.error.code, grantsRes.error.message);
    return { rows: [], membershipId, titleFor: () => null };
  }
  const rows = toRows(grantsRes.data);

  const tenant = await getTenant();
  const held = Object.keys(grantsByCompany(rows));
  const titleCompany = tenant.activeCompanyId && held.includes(tenant.activeCompanyId) ? tenant.activeCompanyId : held[0] ?? null;
  return { rows, membershipId, titleFor: await loadTitleResolver(titleCompany) };
});

/** Effective access for this request: preview-narrowed when an owner previews a role. */
export const getAccess = cache(async (): Promise<Access> => {
  const inputs = await loadAccessInputs();
  if (!inputs) return emptyAccess();
  const jar = await cookies();
  const preview = jar.get(PREVIEW_COOKIE)?.value ?? null;
  return buildAccess(inputs.rows, { membershipId: inputs.membershipId, preview, titleFor: inputs.titleFor });
});

/** The caller's REAL access, ignoring any preview (who may start a preview; the banner's real title). */
export const getRealAccess = cache(async (): Promise<Access> => {
  const inputs = await loadAccessInputs();
  if (!inputs) return emptyAccess();
  return buildAccess(inputs.rows, { membershipId: inputs.membershipId, titleFor: inputs.titleFor });
});

/** Access as it would be under a given preview persona (POST /api/access/preview echoes it). */
export async function getAccessPreviewing(persona: PersonaKey | null): Promise<Access> {
  const inputs = await loadAccessInputs();
  if (!inputs) return emptyAccess();
  return buildAccess(inputs.rows, { membershipId: inputs.membershipId, preview: persona, titleFor: inputs.titleFor });
}
