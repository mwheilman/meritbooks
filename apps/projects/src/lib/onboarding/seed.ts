/**
 * Industry depth set up with the pack install (Wave B), run right after pm.apply_pack_plan on the
 * same RLS client (the installer holds projects.settings:configure):
 *
 *   commercial_gc, specialty_trade        pm.cm_seed_commercial(location) — standard templates and the
 *                                         QA / safety checklists (1120; idempotent, edits survive)
 *   residential_remodel, home_builder     pm.res_settings for the company (1119) — the proposal,
 *                                         selection and trade defaults, inserted once (never overwrites)
 *
 * Schedule templates need no call: pm.pack_installs' trigger copies the pack's catalog (1112).
 * Best effort: a failure is logged and reported, never undoes the install.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type SeedStep = 'commercial_templates' | 'residential_settings';

/** Which seeds a set of installed packs (primary + add-ons) needs, and the residential business kind. */
export function seedsFor(packKeys: ReadonlyArray<string>): { steps: SeedStep[]; businessKind: 'remodel' | 'custom' | 'hybrid' | null } {
  const keys = new Set(packKeys);
  const steps: SeedStep[] = [];
  if (keys.has('commercial_gc') || keys.has('specialty_trade')) steps.push('commercial_templates');
  const remodel = keys.has('residential_remodel');
  const builder = keys.has('home_builder');
  if (remodel || builder) steps.push('residential_settings');
  return { steps, businessKind: remodel && builder ? 'hybrid' : builder ? 'custom' : remodel ? 'remodel' : null };
}

export interface SeedOutcome { step: SeedStep; ok: boolean; detail: string | null }

export async function seedIndustryDepth(db: SupabaseClient, locationId: string, packKeys: ReadonlyArray<string>): Promise<SeedOutcome[]> {
  const { steps, businessKind } = seedsFor(packKeys);
  const out: SeedOutcome[] = [];
  for (const step of steps) {
    try {
      if (step === 'commercial_templates') {
        const r = await db.schema('pm').rpc('cm_seed_commercial', { p_location: locationId });
        out.push({ step, ok: !r.error, detail: r.error ? r.error.message : `${String(r.data ?? 0)} templates` });
      } else {
        const r = await db.schema('pm').from('res_settings')
          .upsert({ location_id: locationId, business_kind: businessKind ?? 'remodel' }, { onConflict: 'org_id,location_id', ignoreDuplicates: true });
        out.push({ step, ok: !r.error, detail: r.error ? r.error.message : null });
      }
    } catch (e) {
      out.push({ step, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const o of out) if (!o.ok) console.warn(`[onboarding/seed] ${o.step} failed`, o.detail);
  return out;
}
