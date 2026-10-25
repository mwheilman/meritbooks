import 'server-only';
/** Pick lists for the installer roster (FLR-32): 1099 installers are vendors, W-2 installers are employees, both sit on a crew. RLS client only. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { pm } from '@/lib/pm/db';

export interface Pick { id: string; label: string }

export async function installerPicks(db: SupabaseClient, companyId: string): Promise<{ vendors: Pick[]; employees: Pick[]; crews: Pick[] }> {
  const [v, e, c] = await Promise.all([
    pm(db).from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true).order('name').limit(1000),
    db.schema('core').from('employees').select('id, first_name, last_name').eq('is_active', true).order('first_name').limit(1000),
    pm(db).from('crews').select('id, name').eq('location_id', companyId).eq('is_active', true).order('name'),
  ]);
  return {
    vendors: ((v.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((x) => ({ id: x.id, label: x.display_name || x.name })),
    employees: ((e.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>).map((x) => ({ id: x.id, label: [x.first_name, x.last_name].filter(Boolean).join(' ') || 'Employee' })),
    crews: ((c.data ?? []) as Array<{ id: string; name: string }>).map((x) => ({ id: x.id, label: x.name })),
  };
}
