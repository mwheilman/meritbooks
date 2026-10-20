/**
 * Which engine modules a company uses: the union of every ACTIVE job type's
 * `pm.job_types.modules` and the company-level `modules` in the resolved plan on
 * `pm.pack_installs`. Pure (unit-tested).
 */
import { MODULES, type ModuleKey } from '@/lib/packs';

export function isModuleKey(k: string): k is ModuleKey {
  return (MODULES as readonly string[]).includes(k);
}

export function resolveModules(
  jobTypeModules: ReadonlyArray<Record<string, boolean> | null | undefined>,
  planModules?: Record<string, boolean> | null,
): ModuleKey[] {
  const on = new Set<ModuleKey>();
  for (const m of [...jobTypeModules, planModules]) {
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) if (v === true && isModuleKey(k)) on.add(k);
  }
  return MODULES.filter((k) => on.has(k));
}

/** Modules for a single job type (job tabs). */
export function jobTypeModules(modules: Record<string, boolean> | null | undefined): Set<ModuleKey> {
  return new Set(resolveModules([modules]));
}
