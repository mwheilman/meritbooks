import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import type { ShellContext } from '@meritbooks/merit-ui';
import { getDb, getTenant, type Company, type TenantContext } from '@/lib/tenant';
import { listInstalls } from '@/lib/pm/config';
import type { PackInstallRow } from '@/lib/pm/types';

/** Projects-owned view cookie: 'consolidated' turns the workspace into the read-only roll-up. */
export const VIEW_COOKIE = 'mp_view';

export type ViewMode = 'company' | 'workspace' | 'consolidated';
export type ReadyTenant = TenantContext & { orgId: string };

export interface Scope {
  tenant: ReadyTenant;
  userId: string;
  view: ViewMode;
  /** The bar state (guide §6.1): company = client, multi-company roll-up = consolidated. */
  context: ShellContext;
  company: Company | null;
  installs: PackInstallRow[];
  /** Companies with an ACTIVE primary pack. */
  installedCompanies: Company[];
  /** Companies this view covers (installed only). */
  companyIds: string[];
  readOnly: boolean;
}

export type ScopeResult =
  | { kind: 'ready'; scope: Scope }
  | { kind: 'gate'; state: 'no_session' | 'no_org' | 'not_entitled'; tenant: TenantContext }
  | { kind: 'onboard'; href: string };

/** Decide what the (app) group shows. Cached per request (layout + page share it). */
export const getScope = cache(async (): Promise<ScopeResult> => {
  const tenant = await getTenant();
  if (tenant.state !== 'ready' || !tenant.orgId || !tenant.clerkUserId) {
    return { kind: 'gate', state: tenant.state === 'ready' ? 'no_org' : tenant.state, tenant };
  }
  const ready = tenant as ReadyTenant;
  if (ready.companies.length === 0) return { kind: 'onboard', href: '/onboarding' };

  const db = await getDb();
  if (!db) return { kind: 'gate', state: 'no_session', tenant };
  const installs = await listInstalls(db, ready.companies.map((c) => c.id));
  const installedIds = new Set(installs.map((i) => i.location_id));
  const installedCompanies = ready.companies.filter((c) => installedIds.has(c.id));

  const active = ready.activeCompanyId ? ready.companies.find((c) => c.id === ready.activeCompanyId) ?? null : null;
  if (active && !installedIds.has(active.id)) return { kind: 'onboard', href: `/onboarding?company=${active.id}` };
  if (!active && installedCompanies.length === 0) {
    return { kind: 'onboard', href: `/onboarding?company=${ready.companies[0]!.id}` };
  }

  const jar = await cookies();
  const wantsConsolidated = jar.get(VIEW_COOKIE)?.value === 'consolidated' && installedCompanies.length > 1;
  const view: ViewMode = active ? 'company' : wantsConsolidated ? 'consolidated' : 'workspace';
  return {
    kind: 'ready',
    scope: {
      tenant: ready,
      userId: tenant.clerkUserId,
      view,
      context: view === 'company' ? 'client' : view,
      company: active,
      installs,
      installedCompanies,
      companyIds: active ? [active.id] : installedCompanies.map((c) => c.id),
      readOnly: view === 'consolidated',
    },
  };
});

/** For pages: the ready scope, or null (the layout is already showing a gate or redirecting). */
export async function pageScope(): Promise<Scope | null> {
  const r = await getScope();
  return r.kind === 'ready' ? r.scope : null;
}

export function companyName(scope: Scope, id: string | null | undefined): string {
  return scope.tenant.companies.find((c) => c.id === id)?.name ?? '';
}

export { booksUrl } from '@/lib/books-url';
