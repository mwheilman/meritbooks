import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModuleKey } from '@/lib/packs';
import { loadMeasures, loadProcurement, loadSelections, loadStockLocations } from './selection-queries';
import { vendorNames } from './scope';
import type { Where } from './field-queries';

export type SelectionsTabKey = 'selections' | 'items' | 'measures';

/** Everything /selections and the job's Selections tab render, and which tabs apply. */
export async function loadSelectionBundle(db: SupabaseClient, w: Where, opts: { modules: ReadonlyArray<ModuleKey>; packKeys: ReadonlyArray<string | null>; inScope: (jobId: string) => boolean }) {
  const [selections, procurement, measureBundle, storage] = await Promise.all([
    loadSelections(db, w),
    loadProcurement(db, w),
    loadMeasures(db, w, opts.inScope),
    loadStockLocations(db, w),
  ]);
  const vendors = await vendorNames(db, procurement.map((x) => x.vendor_id));
  const tabs: SelectionsTabKey[] = [];
  if (opts.modules.includes('selections') || selections.length) tabs.push('selections');
  if (opts.modules.includes('procurement_markup') || procurement.length || opts.packKeys.includes('interior_design') || opts.packKeys.includes('flooring')) tabs.push('items');
  if (opts.packKeys.includes('flooring') || measureBundle.measures.length) tabs.push('measures');
  return { selections, procurement, ...measureBundle, storage, vendors, tabs };
}
