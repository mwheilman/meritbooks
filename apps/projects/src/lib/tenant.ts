import 'server-only';
import { cache } from 'react';
import { auth } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

/**
 * Tenant context for Merit Projects (lead-authored contract; shared by the shell,
 * onboarding and every page). Resolution is THE DATABASE's: every read goes through the
 * RLS-scoped client, so `get_org_id()` (claim → Clerk o.id → single active seat, mig 120)
 * decides the org — the app never parses claims itself, so app and DB can't disagree.
 *
 * States (never conflate "couldn't tell which org" with "not entitled" — review 02 §2 C5):
 *   no_session   → not signed in (middleware normally prevents this)
 *   no_org       → signed in, but no workspace resolves (pick/create a workspace)
 *   not_entitled → org resolved, `entitlements.projects !== true`
 *   ready        → go
 */
export const ACTIVE_COMPANY_COOKIE = 'mp_company';

export interface Company {
  id: string;
  name: string;
  shortCode: string | null;
  industry: string | null;
  revRecMethod: string | null;
  isManagementCompany: boolean;
}

export type TenantState = 'no_session' | 'no_org' | 'not_entitled' | 'ready';

export interface TenantContext {
  state: TenantState;
  clerkUserId: string | null;
  orgId: string | null;
  orgName: string | null;
  entitlements: Record<string, boolean>;
  /** Books present = entitlements.books === true (value, not key presence). */
  booksPresent: boolean;
  /** Operating companies (management company excluded), active only, name order. */
  companies: Company[];
  /** Cookie choice if valid, else the only company, else null (= workspace view). */
  activeCompanyId: string | null;
}

interface OrgRow { id: string; name: string | null; entitlements: Record<string, boolean> | null }
interface LocRow {
  id: string; name: string; short_code: string | null; industry: string | null;
  rev_rec_method: string | null; is_management_company: boolean | null;
}

/** RLS-scoped Supabase client for the current request (null when signed out). */
export const getDb = cache(async (): Promise<SupabaseClient | null> => createAuthedServerSupabase());

export const getTenant = cache(async (): Promise<TenantContext> => {
  const { userId } = await auth();
  const empty: TenantContext = {
    state: 'no_session', clerkUserId: userId ?? null, orgId: null, orgName: null,
    entitlements: {}, booksPresent: false, companies: [], activeCompanyId: null,
  };
  if (!userId) return empty;
  const db = await getDb();
  if (!db) return empty;

  const { data: org } = await db.schema('core').from('organizations')
    .select('id, name, entitlements').limit(1).maybeSingle<OrgRow>();
  if (!org) return { ...empty, state: 'no_org' };

  const entitlements = org.entitlements ?? {};
  const base: TenantContext = {
    ...empty,
    orgId: org.id,
    orgName: org.name,
    entitlements,
    booksPresent: entitlements.books === true,
  };
  if (entitlements.projects !== true) return { ...base, state: 'not_entitled' };

  const { data: locs } = await db.schema('core').from('locations')
    .select('id, name, short_code, industry, rev_rec_method, is_management_company')
    .eq('is_active', true).order('name');
  const companies: Company[] = ((locs ?? []) as LocRow[])
    .filter((l) => !l.is_management_company)
    .map((l) => ({
      id: l.id, name: l.name, shortCode: l.short_code, industry: l.industry,
      revRecMethod: l.rev_rec_method, isManagementCompany: false,
    }));

  const jar = await cookies();
  const chosen = jar.get(ACTIVE_COMPANY_COOKIE)?.value ?? null;
  const activeCompanyId =
    chosen && companies.some((c) => c.id === chosen) ? chosen
    : companies.length === 1 ? companies[0].id
    : null;

  return { ...base, state: 'ready', companies, activeCompanyId };
});

/** Throws-free helper for route handlers: returns ctx only when ready. */
export async function requireReadyTenant(): Promise<(TenantContext & { orgId: string }) | null> {
  const t = await getTenant();
  return t.state === 'ready' && t.orgId ? (t as TenantContext & { orgId: string }) : null;
}
