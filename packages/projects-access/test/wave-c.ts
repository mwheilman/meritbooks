/**
 * Setup for the Wave C (1124) suites: the two-tenant fixture with every migration after 1110
 * applied in order. 1111–1122 and 1124 must apply; another Wave C file still in progress (1123,
 * 1125…) is skipped and reported, never edited.
 */
import { applyMigration, listMigrationFiles } from './pg';
import { buildFixture, type Fixture } from './fixture';

export async function setupWaveC(label: string): Promise<Fixture> {
  const f = await buildFixture();
  const skipped: string[] = [];
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    const n = parseInt(file, 10);
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if (n <= 1122 || n === 1124) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[${label}] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, core_status, is_initial)
                    select org_id, location_id, id, 'm', 'active', 'Active', 'ACTIVE', true from pm.pack_installs
                     where not exists (select 1 from pm.stage_defs s where s.install_id = pack_installs.id and s.stage_key = 'active')`);
  return f;
}
