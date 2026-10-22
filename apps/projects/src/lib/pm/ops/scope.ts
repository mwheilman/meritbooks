import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { count } from '@meritbooks/merit-ui';
import type { ModuleKey } from '@/lib/packs';
import { pageScope, type Scope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { scopedJobs, type ScopedJobs } from '@/lib/pm/scoped';
import type { Vocabulary } from '@/lib/pm/vocab';

export interface OpsScope {
  scope: Scope;
  db: SupabaseClient;
  vocab: Vocabulary;
  modules: ModuleKey[];
  /** Companies this view covers (installed). */
  companyIds: string[];
  companies: Array<{ id: string; name: string }>;
  /** location_id → primary pack key. */
  packByCompany: Record<string, string>;
  /** The active company's pack (null in a workspace view). */
  packKey: string | null;
  multi: boolean;
  /** "Heartland" or "3 companies" — the context-line "where". */
  where: string;
  jobs: ScopedJobs;
  companyName: (id: string | null | undefined) => string | null;
}

/** The scope every ops page starts from (null when the layout is showing a gate). */
export async function opsScope(): Promise<OpsScope | null> {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const [vocab, modules, jobs] = await Promise.all([
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    getModulesFor(db, scope.companyIds, scope.installs),
    scopedJobs(db, scope),
  ]);
  const packByCompany = Object.fromEntries(scope.installs.map((i) => [i.location_id, i.pack_key]));
  const companies = scope.installedCompanies.map((c) => ({ id: c.id, name: c.name }));
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  const multi = scope.companyIds.length > 1;
  return {
    scope,
    db,
    vocab,
    modules,
    companyIds: scope.companyIds,
    companies,
    packByCompany,
    packKey: scope.company ? packByCompany[scope.company.id] ?? null : null,
    multi,
    where: scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`,
    jobs,
    companyName: (id) => (id ? names.get(id) ?? null : null),
  };
}

/** Lightweight job references for client components (label, company, customer). */
export function jobRefs(o: OpsScope, filter?: (jobId: string) => boolean): JobOption[] {
  const out: JobOption[] = [];
  for (const j of o.jobs.byId.values()) {
    if (filter && !filter(j.job_id)) continue;
    out.push({
      id: j.job_id,
      label: [j.job_number, j.name].filter(Boolean).join(' · '),
      companyId: j.location_id,
      company: o.multi ? o.companyName(j.location_id) : null,
      customerId: j.customer_id,
      customer: j.customer_name,
      open: !j.stage_is_terminal,
      jobTypeKey: j.job_type_key,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export interface JobOption {
  id: string;
  label: string;
  companyId: string;
  company: string | null;
  customerId: string | null;
  customer: string | null;
  open: boolean;
  jobTypeKey: string;
}

/** Job types per company that carry a module (create forms offer only these). */
export async function jobTypesWith(db: SupabaseClient, companyIds: ReadonlyArray<string>, module: ModuleKey): Promise<Array<{ companyId: string; key: string; label: string }>> {
  if (!companyIds.length) return [];
  const res = await db.schema('pm').from('job_types').select('location_id, key, label, modules, sort').in('location_id', [...companyIds]).eq('is_active', true).order('sort');
  if (res.error) return [];
  return ((res.data ?? []) as Array<{ location_id: string; key: string; label: string; modules: Record<string, boolean> | null }>)
    .filter((j) => j.modules?.[module] === true)
    .map((j) => ({ companyId: j.location_id, key: j.key, label: j.label }));
}

/** Names for core.customers ids (identity only). */
export async function customerNames(db: SupabaseClient, ids: ReadonlyArray<string | null | undefined>): Promise<Record<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return {};
  const res = await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name').in('id', list.slice(0, 500));
  if (res.error) return {};
  return Object.fromEntries(((res.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((c) => [c.id, c.display_name || c.name]));
}

/** Names for core.vendors ids. */
export async function vendorNames(db: SupabaseClient, ids: ReadonlyArray<string | null | undefined>): Promise<Record<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return {};
  const res = await db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').in('id', list.slice(0, 500));
  if (res.error) return {};
  return Object.fromEntries(((res.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((c) => [c.id, c.display_name || c.name]));
}

export function has(o: Pick<OpsScope, 'modules'>, m: ModuleKey): boolean {
  return o.modules.includes(m);
}
