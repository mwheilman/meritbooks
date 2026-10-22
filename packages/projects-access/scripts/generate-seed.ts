/**
 * Writes the GENERATED blocks of packages/supabase/migrations/1110_pm_access.sql from the
 * code registries in this package:
 *   projects_capabilities     ← src/capabilities.ts  (core.rbac_mirror_capabilities)
 *   projects_role_templates   ← src/roles.ts         (core.rbac_seed_platform_roles)
 *   projects_permission_sets  ← src/roles.ts         (core.rbac_seed_platform_permission_sets)
 *   projects_persona_rank     ← src/roles.ts         (pm.access_persona_rank)
 *
 * Usage (from packages/projects-access):  npx tsx scripts/generate-seed.ts [--check]
 *   --check  exit 1 if any block is out of date (no write).
 *
 * The guard test test/registry.test.ts replays every migration and compares the DB to the
 * code independently, so a stale block also fails the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_CAPABILITIES, riskTier, isPlatformOnly } from '../src/capabilities';
import { PROJECT_ROLE_TEMPLATES, PROJECT_PERMISSION_SET_TEMPLATES } from '../src/roles';

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../supabase/migrations/1110_pm_access.sql',
);
const GENERATOR = 'packages/projects-access/scripts/generate-seed.ts — do not edit by hand';

const dollar = (json: string): string => {
  if (json.includes('$seed$')) throw new Error('seed json contains the dollar-quote tag');
  return `$seed$${json}$seed$::jsonb`;
};
const jsonLines = (rows: unknown[]): string => `[\n${rows.map((r) => '  ' + JSON.stringify(r)).join(',\n')}\n]`;
const sqlText = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function capabilitiesBlock(): string {
  const rows = PROJECT_CAPABILITIES.map((c) => ({
    key: c.key,
    module: c.module,
    domain: c.domain,
    actions: c.actions,
    label: c.label,
    description: c.description,
    tags: c.tags,
    risk_tier: riskTier(c),
    platform_only: isPlatformOnly(c),
    field_classes: c.fieldClasses,
    supports_constraints: c.supportsConstraints,
    introduced_in: c.introducedIn,
    status: c.status,
  }));
  return `select core.rbac_mirror_capabilities(${dollar(jsonLines(rows))});`;
}

export function roleTemplatesBlock(): string {
  const rows = PROJECT_ROLE_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    audience: t.audience,
    default_scope: t.defaultScope,
    field_policy: t.fieldPolicy,
    auth_policy: t.authPolicy,
    max_assignment_days: t.maxAssignmentDays,
    assignable_band: t.assignableBand,
    grants: t.grants,
  }));
  return `select core.rbac_seed_platform_roles(${dollar(jsonLines(rows))});`;
}

export function permissionSetsBlock(): string {
  const rows = PROJECT_PERMISSION_SET_TEMPLATES.map((s) => ({
    key: s.key,
    name: s.name,
    description: s.description,
    audience: s.audience,
    field_policy: s.fieldPolicy,
    max_assignment_days: s.maxAssignmentDays,
    is_envelope: s.isEnvelope,
    is_sealed: s.isSealed,
    grants: s.grants,
  }));
  return `select core.rbac_seed_platform_permission_sets(${dollar(jsonLines(rows))});`;
}

export function personaRankBlock(): string {
  const arms = PROJECT_ROLE_TEMPLATES.map((t) => `    when ${sqlText(t.key)} then ${t.rank}`).join('\n');
  return [
    'create or replace function pm.access_persona_rank(p_key text) returns integer',
    'language sql immutable',
    'as $$',
    '  select case p_key',
    arms,
    '    else 0 end',
    '$$;',
  ].join('\n');
}

const BLOCKS: ReadonlyArray<[string, () => string]> = [
  ['projects_capabilities', capabilitiesBlock],
  ['projects_role_templates', roleTemplatesBlock],
  ['projects_permission_sets', permissionSetsBlock],
  ['projects_persona_rank', personaRankBlock],
];

export function renderMigration(sql: string): string {
  let out = sql;
  for (const [name, render] of BLOCKS) {
    const begin = `-- BEGIN GENERATED ${name} (${GENERATOR})`;
    const end = `-- END GENERATED ${name}`;
    const i = out.indexOf(begin);
    const j = out.indexOf(end);
    if (i < 0 || j < 0 || j < i) throw new Error(`markers for ${name} not found in ${MIGRATION}`);
    out = out.slice(0, i + begin.length) + '\n' + render() + '\n' + out.slice(j);
  }
  return out;
}

function main(): void {
  const check = process.argv.includes('--check');
  const current = fs.readFileSync(MIGRATION, 'utf8');
  const next = renderMigration(current);
  if (check) {
    if (next !== current) {
      console.error('1110_pm_access.sql GENERATED blocks are stale — run: npx tsx scripts/generate-seed.ts');
      process.exit(1);
    }
    console.log('1110_pm_access.sql GENERATED blocks are up to date');
    return;
  }
  if (next !== current) fs.writeFileSync(MIGRATION, next);
  console.log(next === current ? 'no changes' : 'wrote GENERATED blocks into 1110_pm_access.sql');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
