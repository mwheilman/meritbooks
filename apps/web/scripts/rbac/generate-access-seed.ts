/**
 * Writes the GENERATED blocks of the wave-1 access migrations from the code registries:
 *   157_capability_registry.sql   ← lib/rbac/capabilities.ts
 *   158_role_definitions.sql      ← lib/rbac/legacy-map.ts (legacy block)
 *                                   lib/rbac/access-templates.ts (role_templates block)
 *   159_permission_sets.sql       ← lib/rbac/access-templates.ts (permission_sets block)
 *   168_events_vendors_locks_and_money_kinds.sql ← lib/rbac/legacy-map.ts (rules introducedIn '168')
 *
 * Usage (from apps/web):  npx tsx scripts/rbac/generate-access-seed.ts [--check]
 *   --check  exit 1 if any block is out of date (no write).
 *
 * The guard test src/test/access-foundations.test.ts independently replays the
 * migrations and compares the DB to the code, so a stale block also fails the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, riskTier, isPlatformOnly } from '../../src/lib/rbac/capabilities';
import { ROLE_DEFINITIONS, FEATURE_CATALOG, ALL_ROLES } from '../../src/lib/rbac/permissions';
import {
  LEGACY_ROLE_TO_TEMPLATE,
  LEGACY_SPLIT,
  LEGACY_SET_KEY,
  legacyScopeKind,
  legacyFieldPolicy,
  legacyAssignableBand,
  legacyRoleCells,
  legacyRuleRows,
  expandLegacyCells,
} from '../../src/lib/rbac/legacy-map';
import {
  ROLE_TEMPLATES,
  PERMISSION_SET_TEMPLATES,
  legacyFullBooksGrants,
  legacyControllerReleaseGrants,
  type PermissionSetTemplate,
} from '../../src/lib/rbac/access-templates';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/supabase/migrations');

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sqlArr = (xs: readonly string[]) => (xs.length === 0 ? `'{}'::text[]` : `array[${xs.map(sqlText).join(', ')}]::text[]`);
const dollar = (json: string) => {
  if (json.includes('$seed$')) throw new Error('seed json contains the dollar-quote tag');
  return `$seed$${json}$seed$::jsonb`;
};
const jsonLines = (rows: unknown[]) => `[\n${rows.map((r) => '  ' + JSON.stringify(r)).join(',\n')}\n]`;

function capabilitiesBlock(): string {
  const rows = CAPABILITIES.map((c) => ({
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

function legacyBlock(): string {
  const out: string[] = [];
  out.push('insert into core.legacy_roles (role_key, template_key, label, company_scope, scope_kind, payroll_visibility, mfa_required, field_policy, assignable_band, split, legacy_set_key) values');
  out.push(
    ALL_ROLES.map((r) => {
      const d = ROLE_DEFINITIONS[r];
      const setKey = LEGACY_SET_KEY[r];
      return `  (${[
        sqlText(r), sqlText(LEGACY_ROLE_TO_TEMPLATE[r]), sqlText(d.label), sqlText(d.companyScope),
        sqlText(legacyScopeKind(r)), sqlText(d.payrollVisibility), String(d.mfaRequired),
        `${sqlText(JSON.stringify(legacyFieldPolicy(r)))}::jsonb`, sqlText(legacyAssignableBand(r)),
        sqlText(LEGACY_SPLIT[r]), setKey ? sqlText(setKey) : 'null',
      ].join(', ')})`;
    }).join(',\n'),
  );
  out.push('on conflict (role_key) do update set template_key = excluded.template_key, label = excluded.label, company_scope = excluded.company_scope, scope_kind = excluded.scope_kind, payroll_visibility = excluded.payroll_visibility, mfa_required = excluded.mfa_required, field_policy = excluded.field_policy, assignable_band = excluded.assignable_band, split = excluded.split, legacy_set_key = excluded.legacy_set_key;');

  out.push('insert into core.legacy_feature_catalog (feature, actions) values');
  out.push(FEATURE_CATALOG.map((f) => `  (${sqlText(f.id)}, ${sqlArr(f.actions)})`).join(',\n'));
  out.push('on conflict (feature) do update set actions = excluded.actions;');

  out.push('delete from core.legacy_role_cells;');
  out.push('insert into core.legacy_role_cells (role_key, cell) values');
  const cellRows: string[] = [];
  for (const r of ALL_ROLES) for (const c of [...legacyRoleCells(r)].sort()) cellRows.push(`  (${sqlText(r)}, ${sqlText(c)})`);
  out.push(cellRows.join(',\n') + ';');

  out.push('delete from core.legacy_cell_rules;');
  out.push('insert into core.legacy_cell_rules (rule_no, cell, capability, actions, requires_all, requires_any) values');
  out.push(
    legacyRuleRows()
      .filter((r) => r.introducedIn === '158')
      .map((r) => `  (${r.ruleNo}, ${sqlText(r.cell)}, ${sqlText(r.capability)}, ${sqlArr(r.actions)}, ${sqlArr(r.requiresAll)}, ${sqlArr(r.requiresAny)})`)
      .join(',\n') + ';',
  );
  return out.join('\n');
}

/**
 * Legacy-rule corrections appended after 158 went live (rule numbers continue; 158's
 * block deletes + re-inserts only its own rules, so a fresh replay stays exact).
 */
function legacyCorrectionsBlock(migration: string): () => string {
  return () => {
    const rows = legacyRuleRows().filter((r) => r.introducedIn === migration);
    if (rows.length === 0) throw new Error(`no legacy rules introduced in ${migration}`);
    return [
      'insert into core.legacy_cell_rules (rule_no, cell, capability, actions, requires_all, requires_any, introduced_in) values',
      rows
        .map((r) => `  (${r.ruleNo}, ${sqlText(r.cell)}, ${sqlText(r.capability)}, ${sqlArr(r.actions)}, ${sqlArr(r.requiresAll)}, ${sqlArr(r.requiresAny)}, ${sqlText(r.introducedIn)})`)
        .join(',\n'),
      'on conflict (rule_no, capability) do update set cell = excluded.cell, actions = excluded.actions, requires_all = excluded.requires_all, requires_any = excluded.requires_any, introduced_in = excluded.introduced_in;',
    ].join('\n');
  };
}

function roleTemplatesBlock(): string {
  const rows = ROLE_TEMPLATES.map((t) => ({
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

/**
 * Grants of the two legacy permission-set templates AS 159 SHIPPED THEM (original 158
 * rules). 159 is live; later rule corrections publish a new template version from the
 * correcting migration (see permissionSetsCorrectionBlock).
 */
function originalLegacySetGrants(key: string): PermissionSetTemplate['grants'] | null {
  if (key === 'legacy_full_books') {
    return legacyFullBooksGrants(expandLegacyCells(legacyRoleCells('company_admin'), { onlyOriginal: true }));
  }
  if (key === 'legacy_controller_release') {
    return legacyControllerReleaseGrants(expandLegacyCells(legacyRoleCells('merit_controller'), { onlyOriginal: true }));
  }
  return null;
}

function permissionSetsBlock(): string {
  const rows = PERMISSION_SET_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    audience: t.audience,
    field_policy: t.fieldPolicy,
    max_assignment_days: t.maxAssignmentDays,
    is_envelope: t.isEnvelope,
    is_sealed: t.isSealed,
    grants: originalLegacySetGrants(t.key) ?? t.grants,
  }));
  return `select core.rbac_seed_platform_permission_sets(${dollar(jsonLines(rows))});`;
}

/** Platform legacy sets whose grants changed with the 168 rule corrections → new version. */
function permissionSetsCorrectionBlock(): string {
  const rows = PERMISSION_SET_TEMPLATES
    .filter((t) => t.key === 'legacy_full_books' || t.key === 'legacy_controller_release')
    .map((t) => ({ key: t.key, grants: t.grants }));
  return `select core.rbac_republish_platform_permission_sets(${dollar(jsonLines(rows))}, 'MeritBooks correction (migration 168): AR refund approval / release');`;
}

const BLOCKS: Array<{ file: string; name: string; body: () => string }> = [
  { file: '157_capability_registry.sql', name: 'capabilities', body: capabilitiesBlock },
  { file: '158_role_definitions.sql', name: 'legacy', body: legacyBlock },
  { file: '158_role_definitions.sql', name: 'role_templates', body: roleTemplatesBlock },
  { file: '159_permission_sets.sql', name: 'permission_sets', body: permissionSetsBlock },
  { file: '168_events_vendors_locks_and_money_kinds.sql', name: 'legacy_168', body: legacyCorrectionsBlock('168') },
  { file: '168_events_vendors_locks_and_money_kinds.sql', name: 'permission_sets_168', body: permissionSetsCorrectionBlock },
];

export function renderBlock(sql: string, name: string, body: string): string {
  const re = new RegExp(`(-- BEGIN GENERATED ${name} [^\\n]*\\n)[\\s\\S]*?(-- END GENERATED ${name}\\n)`);
  if (!re.test(sql)) throw new Error(`markers for ${name} not found`);
  return sql.replace(re, (_m, begin: string, end: string) => `${begin}${body}\n${end}`);
}

function main(): void {
  const check = process.argv.includes('--check');
  let stale = false;
  const files = new Map<string, string>();
  for (const b of BLOCKS) {
    const p = path.join(MIGRATIONS, b.file);
    const before = files.get(p) ?? fs.readFileSync(p, 'utf8');
    files.set(p, renderBlock(before, b.name, b.body()));
  }
  for (const [p, after] of files) {
    const before = fs.readFileSync(p, 'utf8');
    if (before === after) continue;
    stale = true;
    if (!check) {
      fs.writeFileSync(p, after);
      console.log(`wrote ${path.basename(p)}`);
    } else {
      console.error(`stale: ${path.basename(p)}`);
    }
  }
  if (check && stale) process.exit(1);
  if (!stale) console.log('generated blocks up to date');
}

main();
