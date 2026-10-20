import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPack, type ModuleKey } from '@meritbooks/industry-packs';
import { one, pm, rows } from './db';
import { resolveModules } from './modules';
import { vocabularyFrom, workspaceVocabulary, type Vocabulary, type VocabRow } from './vocab';
import type { JobTypeRow, PackInstallRow } from './types';

const INSTALL_COLS = 'id, location_id, pack_key, pack_version, installed_at, modules:resolved->modules, vocabulary:resolved->vocabulary';

/** ACTIVE primary pack installs (one per company at most). */
export async function listInstalls(db: SupabaseClient, companyIds?: ReadonlyArray<string>): Promise<PackInstallRow[]> {
  let q = pm(db).from('pack_installs').select(INSTALL_COLS).eq('role', 'primary').eq('status', 'ACTIVE');
  if (companyIds && companyIds.length) q = q.in('location_id', [...companyIds]);
  return rows<PackInstallRow>(await q, 'pack installs');
}

export interface InstalledPack extends PackInstallRow {
  /** Pack display name from the catalog ("Residential remodel"), or the key. */
  name: string;
  tagline: string | null;
}

export async function getInstalledPack(db: SupabaseClient, companyId: string): Promise<InstalledPack | null> {
  const row = one<PackInstallRow>(
    await pm(db).from('pack_installs').select(INSTALL_COLS).eq('location_id', companyId).eq('role', 'primary').eq('status', 'ACTIVE').maybeSingle(),
    'installed pack',
  );
  if (!row) return null;
  const manifest = safePack(row.pack_key, row.pack_version);
  return { ...row, name: manifest?.name ?? row.pack_key, tagline: manifest?.tagline ?? null };
}

function safePack(key: string, version: string) {
  try {
    return getPack(key, version) ?? getPack(key) ?? null;
  } catch {
    return null;
  }
}

/** Modules a company uses: union of active job types' modules and the plan's modules. */
export async function getModules(db: SupabaseClient, companyId: string): Promise<ModuleKey[]> {
  const [jts, install] = await Promise.all([
    rows<Pick<JobTypeRow, 'modules'>>(await pm(db).from('job_types').select('modules').eq('location_id', companyId).eq('is_active', true), 'job type modules'),
    listInstalls(db, [companyId]),
  ]);
  return resolveModules(jts.map((j) => j.modules), install[0]?.modules ?? null);
}

/** Modules across several companies (workspace rail): the union. */
export async function getModulesFor(db: SupabaseClient, companyIds: ReadonlyArray<string>, installs: ReadonlyArray<PackInstallRow>): Promise<ModuleKey[]> {
  if (companyIds.length === 0) return [];
  const jts = rows<Pick<JobTypeRow, 'modules'>>(
    await pm(db).from('job_types').select('modules').in('location_id', [...companyIds]).eq('is_active', true),
    'job type modules',
  );
  return resolveModules([...jts.map((j) => j.modules), ...installs.filter((i) => companyIds.includes(i.location_id)).map((i) => i.modules)]);
}

export async function listVocabRows(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<VocabRow[]> {
  let q = pm(db).from('v_vocabulary').select('location_id, vocab_key, label');
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  try {
    return rows<VocabRow>(await q, 'vocabulary');
  } catch {
    return []; // display-only: fall back to the defaults rather than fail the page
  }
}

/** One company's vocabulary, or the workspace's shared terms, with DEFAULT_VOCAB fallback. */
export async function getVocabulary(db: SupabaseClient, companyId: string | null, companyIds: ReadonlyArray<string> = []): Promise<Vocabulary> {
  const ids = companyId ? [companyId] : companyIds;
  const vrows = await listVocabRows(db, ids);
  return companyId ? vocabularyFrom(vrows, companyId) : workspaceVocabulary(vrows, ids);
}
