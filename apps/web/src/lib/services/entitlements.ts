/**
 * Module entitlements (Suite-Core-owned, stored on core.organizations.entitlements).
 *
 * Books must run standalone (contract §10). The entitlements layer tells Books
 * whether a sibling module is present, so it knows whether to *expect* its events
 * (e.g. JOB_PROGRESS from Projects) or to expose direct entry instead. Absence is
 * the safe default: no entitlement → Books shows direct entry and never blocks.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;
export type SuiteModule = 'projects' | 'inventory' | 'hr' | 'payroll';

/** Read the tenant's entitlements blob. Missing/blank => {} (fully standalone). */
export async function getEntitlements(db: DB, orgId: string): Promise<Record<string, boolean>> {
  const { data } = await db.schema('core').from('organizations').select('entitlements').eq('id', orgId).maybeSingle();
  const raw = (data as { entitlements?: unknown } | null)?.entitlements;
  return (raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {});
}

/** Is a sibling module installed for this tenant? Defaults to false (standalone). */
export async function hasModule(db: DB, orgId: string, module: SuiteModule): Promise<boolean> {
  const ent = await getEntitlements(db, orgId);
  return ent[module] === true;
}
