import 'server-only';
/**
 * Loads a company's industry experience for this request: its ACTIVE primary + add-on installs,
 * its active job types and the tenant's /experience/… overrides (pm.pack_overrides is class O:
 * every member reads it; only settings:configure writes). RLS client only. Display config, so
 * every failure falls back to null (the app's built-in rails and module-driven tabs).
 */
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm } from '@/lib/pm/db';
import { experienceFor, type CompanyExperience, type PackOverride } from './experience';

interface InstallRow { id: string; pack_key: string; pack_version: string; role: 'primary' | 'addon' }

async function load(db: SupabaseClient, companyId: string): Promise<CompanyExperience | null> {
  try {
    const inst = await pm(db).from('pack_installs').select('id, pack_key, pack_version, role')
      .eq('location_id', companyId).eq('status', 'ACTIVE');
    if (inst.error) return null;
    const installs = (inst.data ?? []) as InstallRow[];
    const primary = installs.find((r) => r.role === 'primary');
    if (!primary) return null;
    const [jts, ovs] = await Promise.all([
      pm(db).from('job_types').select('key').eq('location_id', companyId).eq('is_active', true),
      pm(db).from('pack_overrides').select('json_pointer, op, value, created_at').eq('install_id', primary.id)
        .like('json_pointer', '/experience/%').order('created_at'),
    ]);
    const keys = jts.error ? null : ((jts.data ?? []) as Array<{ key: string }>).map((r) => r.key);
    const overrides = ovs.error ? [] : ((ovs.data ?? []) as PackOverride[]);
    return experienceFor({
      primary,
      addons: installs.filter((r) => r.role === 'addon'),
      jobTypeKeys: keys && keys.length ? keys : null,
      overrides,
    });
  } catch {
    return null;
  }
}

/** One company's experience, cached per request. */
export const getCompanyExperience = cache(async (db: SupabaseClient, companyId: string | null): Promise<CompanyExperience | null> => {
  if (!companyId) return null;
  return load(db, companyId);
});
