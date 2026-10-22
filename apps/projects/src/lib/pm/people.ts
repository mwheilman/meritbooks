import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanSearch, core, one, pm, rows } from './db';
import type { CustomerRow } from './types';

export interface Me {
  role: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** The caller's employee row (core.employees.role via RLS). */
export async function getMe(db: SupabaseClient, clerkUserId: string): Promise<Me> {
  try {
    const row = one<{ role: string | null; first_name: string | null; last_name: string | null }>(
      await core(db).from('employees').select('role, first_name, last_name').eq('clerk_user_id', clerkUserId).eq('is_active', true).limit(1).maybeSingle(),
      'me',
    );
    return { role: row?.role ?? null, firstName: row?.first_name ?? null, lastName: row?.last_name ?? null };
  } catch {
    return { role: null, firstName: null, lastName: null };
  }
}

/** Owners and admins read the report-density home; everyone else the PM cockpit. */
export const REPORT_ROLES: ReadonlySet<string> = new Set(['owner', 'company_admin', 'admin']);

export function homeDensityFor(role: string | null | undefined): 'report' | 'cockpit' {
  return role && REPORT_ROLES.has(role) ? 'report' : 'cockpit';
}

export const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: 'Owner',
  company_admin: 'Company admin',
  admin: 'Admin',
  project_manager: 'Project manager',
  accounting_specialist: 'Accounting',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return 'Member';
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Customers matching a name (core.customers, identity only). */
export async function searchCustomers(db: SupabaseClient, q: string, companyId?: string | null, limit = 8): Promise<CustomerRow[]> {
  const term = cleanSearch(q);
  let query = pm(db).from('v_core_customers_masked').select('id, name, display_name, location_id').eq('is_active', true).is('deleted_at', null);
  if (term) query = query.or(`name.ilike.*${term}*,display_name.ilike.*${term}*`);
  const list = rows<CustomerRow>(await query.order('name').limit(limit * 3), 'customers');
  return list.filter((c) => !companyId || c.location_id == null || c.location_id === companyId).slice(0, limit);
}

/** Clerk user id → "Dana Lee" for the people named on jobs (PM, super). */
export async function employeeNames(db: SupabaseClient, clerkIds: ReadonlyArray<string | null>): Promise<Record<string, string>> {
  const ids = [...new Set(clerkIds.filter((x): x is string => !!x))];
  if (!ids.length) return {};
  try {
    const list = rows<{ clerk_user_id: string; first_name: string | null; last_name: string | null }>(
      await core(db).from('employees').select('clerk_user_id, first_name, last_name').in('clerk_user_id', ids),
      'employee names',
    );
    return Object.fromEntries(list.map((e) => [e.clerk_user_id, [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member']));
  } catch {
    return {};
  }
}
