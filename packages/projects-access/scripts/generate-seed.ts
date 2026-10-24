/**
 * Writes the GENERATED blocks of the Projects access migrations from the code registries in
 * this package. Each block is rendered in the HIGHEST-numbered migration that carries its
 * markers; earlier carriers are frozen history (1110 is live in production — a change to the
 * code ships as a later migration carrying the block, e.g. 1111 for the role templates):
 *   projects_capabilities     ← src/capabilities.ts  (core.rbac_mirror_capabilities)
 *   projects_role_templates   ← src/roles.ts         (core.rbac_seed_platform_roles)
 *   projects_permission_sets  ← src/roles.ts         (core.rbac_seed_platform_permission_sets)
 *   projects_persona_rank     ← src/roles.ts         (pm.access_persona_rank)
 * In 1110 the role templates are seeded with core.rbac_seed_platform_roles; in a later carrier
 * with pm.access_sync_role_templates (1111), which also publishes changed grants to the platform
 * templates and adds new actions to every tenant clone.
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

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
const FIRST_CARRIER = '1110_pm_access.sql';
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

export function roleTemplatesBlock(file: string = FIRST_CARRIER): string {
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
  const fn = file === FIRST_CARRIER ? 'core.rbac_seed_platform_roles' : 'pm.access_sync_role_templates';
  return `select ${fn}(${dollar(jsonLines(rows))});`;
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

const BLOCKS: ReadonlyArray<[string, (file: string) => string]> = [
  ['projects_capabilities', () => capabilitiesBlock()],
  ['projects_role_templates', (file) => roleTemplatesBlock(file)],
  ['projects_permission_sets', () => permissionSetsBlock()],
  ['projects_persona_rank', () => personaRankBlock()],
];

const beginOf = (name: string): string => `-- BEGIN GENERATED ${name} (${GENERATOR})`;
const endOf = (name: string): string => `-- END GENERATED ${name}`;

/** Render the named blocks inside one migration's text (markers must be present). */
export function renderMigration(sql: string, file: string = FIRST_CARRIER, names: ReadonlyArray<string> = BLOCKS.map(([n]) => n)): string {
  let out = sql;
  for (const [name, render] of BLOCKS) {
    if (!names.includes(name)) continue;
    const i = out.indexOf(beginOf(name));
    const j = out.indexOf(endOf(name));
    if (i < 0 || j < 0 || j < i) throw new Error(`markers for ${name} not found in ${file}`);
    out = out.slice(0, i + beginOf(name).length) + '\n' + render(file) + '\n' + out.slice(j);
  }
  return out;
}

/** Migration files in numeric order. */
function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/** Each block's carrier = the highest-numbered migration with its markers. file → { current, rendered }. */
export function renderCarriers(): Map<string, { current: string; rendered: string; blocks: string[] }> {
  const files = migrationFiles();
  const texts = new Map(files.map((f) => [f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')] as const));
  const byFile = new Map<string, string[]>();
  for (const [name] of BLOCKS) {
    const carrier = [...files].reverse().find((f) => (texts.get(f) ?? '').includes(beginOf(name)));
    if (!carrier) throw new Error(`no migration carries the GENERATED block ${name}`);
    byFile.set(carrier, [...(byFile.get(carrier) ?? []), name]);
  }
  const out = new Map<string, { current: string; rendered: string; blocks: string[] }>();
  for (const [file, names] of byFile) {
    const current = texts.get(file) ?? '';
    out.set(file, { current, rendered: renderMigration(current, file, names), blocks: names });
  }
  return out;
}

function main(): void {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [file, { current, rendered, blocks }] of renderCarriers()) {
    if (rendered === current) { console.log(`${file}: up to date (${blocks.join(', ')})`); continue; }
    stale = true;
    if (check) { console.error(`${file}: GENERATED blocks are stale (${blocks.join(', ')}) — run: npx tsx scripts/generate-seed.ts`); continue; }
    fs.writeFileSync(path.join(MIGRATIONS_DIR, file), rendered);
    console.log(`${file}: wrote GENERATED blocks (${blocks.join(', ')})`);
  }
  if (check && stale) process.exit(1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
