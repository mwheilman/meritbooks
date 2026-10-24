/**
 * Budget templates and the department "start from …" generators (Wave 4B, AC-B14 / AC-B13).
 *
 *   listTemplates       system (code) + tenant (public.budget_templates, latest version per key)
 *   saveTenantTemplate  insert version n+1 of a key (rows are immutable; the old version stays)
 *   previewTemplate     what a template would put into one department (no writes)
 *   applyTemplate       write it: cells (source TEMPLATE) + a driver per row + the plan's template
 *   startFromPriorYear  last year's actuals for the department + x%, month shape kept
 */
import { generate, specFrom, MONTHS } from '../generators';
import { BudgetError } from '../lifecycle';
import { canSeeDepartment } from '../scope';
import { SYSTEM_TEMPLATES, systemTemplate } from '../templates/system';
import { planTemplate } from '../templates/resolve';
import { patternError } from '../templates/pattern';
import { DEPARTMENT_KINDS, type BudgetTemplate, type DepartmentKind, type TemplateLine, type TemplatePreviewLine } from '../types';
import { assertEditable, pyActualsByAccount, upsertDriver, writeCells } from './lines';
import { loadAccounts, loadVersion, logEvent, must, type BudgetCtx } from './data';

type Row = Record<string, unknown>;

function toTemplate(r: Row): BudgetTemplate {
  return {
    id: String(r.id),
    scope: 'tenant',
    key: String(r.template_key),
    version: Number(r.version),
    name: String(r.name),
    departmentKind: (DEPARTMENT_KINDS as readonly string[]).includes(String(r.department_kind)) ? (String(r.department_kind) as DepartmentKind) : 'OTHER',
    description: String(r.description ?? ''),
    basedOn: r.based_on == null ? null : String(r.based_on),
    lines: Array.isArray(r.lines) ? (r.lines as TemplateLine[]) : [],
    kpis: Array.isArray(r.kpis) ? (r.kpis as string[]) : [],
  };
}

export async function listTemplates(ctx: BudgetCtx): Promise<{ system: BudgetTemplate[]; tenant: BudgetTemplate[]; history: Record<string, number[]> }> {
  const rows = must(await ctx.reader.from('budget_templates').select('*'), 'templates') as Row[];
  const latest = new Map<string, Row>();
  const history: Record<string, number[]> = {};
  for (const r of rows) {
    const k = String(r.template_key);
    history[k] = [...(history[k] ?? []), Number(r.version)].sort((a, b) => a - b);
    const cur = latest.get(k);
    if (!cur || Number(r.version) > Number(cur.version)) latest.set(k, r);
  }
  return { system: [...SYSTEM_TEMPLATES], tenant: [...latest.values()].map(toTemplate).sort((a, b) => a.name.localeCompare(b.name)), history };
}

export async function getTemplate(ctx: BudgetCtx, id: string, version?: number | null): Promise<BudgetTemplate> {
  if (id.startsWith('system:')) {
    const t = systemTemplate(id.slice('system:'.length));
    if (!t) throw new BudgetError('NOT_FOUND', 'That template was not found.');
    return t;
  }
  const rows = must(await ctx.reader.from('budget_templates').select('*').eq('id', id), 'template') as Row[];
  if (!rows[0]) throw new BudgetError('NOT_FOUND', 'That template was not found.');
  if (version && Number(rows[0].version) !== version) {
    const v = must(await ctx.reader.from('budget_templates').select('*').eq('template_key', String(rows[0].template_key)).eq('version', version), 'template') as Row[];
    if (v[0]) return toTemplate(v[0]);
  }
  return toTemplate(rows[0]);
}

export interface SaveTemplateInput {
  key?: string | null;
  basedOn?: string | null;
  name: string;
  departmentKind: DepartmentKind;
  description?: string | null;
  lines: TemplateLine[];
  kpis?: string[];
}

export function slugKey(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return /^[a-z0-9]/.test(s) && s.length >= 2 ? s : `template-${Date.now().toString(36)}`;
}

export async function saveTenantTemplate(ctx: BudgetCtx, i: SaveTemplateInput, locationIdForAudit: string): Promise<BudgetTemplate> {
  if (ctx.access.scope !== 'ALL' || !ctx.access.canEdit) throw new BudgetError('SCOPE', 'Only finance can edit budget templates.');
  if (i.lines.length === 0) throw new BudgetError('VALIDATION', 'A template needs at least one line.');
  for (const l of i.lines) {
    for (const src of [l.selector.name, l.selector.group, l.selector.notName]) {
      const err = src ? patternError(src) : null;
      if (err) throw new BudgetError('VALIDATION', `“${l.label}”: ${err}`);
    }
  }
  const key = i.key && /^[a-z0-9][a-z0-9_-]{1,79}$/.test(i.key) ? i.key : slugKey(i.name);
  const existing = must(await ctx.reader.from('budget_templates').select('id, version').eq('template_key', key), 'templates') as Array<{ id: string; version: number }>;
  const version = existing.reduce((m, r) => Math.max(m, Number(r.version)), 0) + 1;
  const ins = must(
    await ctx.writer.from('budget_templates').insert({
      org_id: ctx.orgId, template_key: key, version, name: i.name.trim().slice(0, 120), department_kind: i.departmentKind,
      description: i.description ?? null, based_on: i.basedOn ?? null, lines: i.lines, kpis: i.kpis ?? [], is_active: true, created_by: ctx.userId,
    }).select('*'),
    'save template',
  ) as Row[];
  for (const r of existing) must(await ctx.writer.from('budget_templates').update({ is_active: false }).eq('id', r.id), 'template versions');
  await logEvent(ctx, { locationId: locationIdForAudit, kind: 'TEMPLATE_SAVED', meta: { template_key: key, version, based_on: i.basedOn ?? null } });
  return toTemplate(ins[0]);
}

export interface PreviewResult {
  template: BudgetTemplate;
  lines: TemplatePreviewLine[];
  missing: TemplateLine[];
  annualRevenueCents: number;
  annualExpenseCents: number;
}

export async function previewTemplate(
  ctx: BudgetCtx,
  versionId: string,
  departmentId: string | null,
  templateId: string,
  growthOverrideBps: number | null,
  templateVersion?: number | null,
): Promise<PreviewResult> {
  const version = await loadVersion(ctx.reader, versionId);
  if (!canSeeDepartment(ctx.access, departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const template = await getTemplate(ctx, templateId, templateVersion);
  const { list, byId } = await loadAccounts(ctx.reader, ctx.orgId);
  const py = await pyActualsByAccount(ctx, version.locationId, version.fiscalYear, departmentId, byId);
  const { lines, missing } = planTemplate(template, list, { pyMonthsByAccount: py, growthOverrideBps });
  let rev = 0;
  let exp = 0;
  for (const l of lines) {
    const a = l.account;
    if (!a) continue;
    if (a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME')) rev += l.annualCents;
    else exp += l.annualCents;
  }
  return { template, lines, missing, annualRevenueCents: rev, annualExpenseCents: exp };
}

export async function applyTemplate(
  ctx: BudgetCtx,
  versionId: string,
  departmentId: string | null,
  templateId: string,
  growthOverrideBps: number | null,
  templateVersion?: number | null,
): Promise<PreviewResult & { changed: number }> {
  const version = await loadVersion(ctx.reader, versionId);
  await assertEditable(ctx, version, departmentId);
  const p = await previewTemplate(ctx, versionId, departmentId, templateId, growthOverrideBps, templateVersion);
  const cells = p.lines.flatMap((l) => (l.account ? l.months.map((v, k) => ({ accountId: l.account!.id, periodNumber: k + 1, amountCents: v })) : []));
  const changed = await writeCells(ctx, version, departmentId, cells, 'TEMPLATE', { closedMonths: 'skip' });
  for (const l of p.lines) {
    if (!l.account) continue;
    let spec = specFrom(l.line.method, l.line.params);
    if ((spec.method === 'PY_GROWTH' || spec.method === 'PRIOR_BUDGET_GROWTH') && growthOverrideBps != null) spec = { ...spec, growthBps: growthOverrideBps };
    await upsertDriver(ctx, version, departmentId, l.account.id, spec, l.annualCents, l.line.bridgeDriver ?? 'AUTO', l.line.note ?? null);
  }
  if (departmentId) {
    must(await ctx.writer.from('budget_department_plans').update({ template_key: p.template.key, template_version: p.template.version })
      .eq('version_id', versionId).eq('department_id', departmentId), 'plan template');
  }
  await logEvent(ctx, { locationId: version.locationId, versionId, kind: 'LINES_GENERATED', meta: { department_id: departmentId, template: p.template.id, template_version: p.template.version, lines: p.lines.length, missing: p.missing.map((m) => m.key) } });
  return { ...p, changed };
}

/** "Start from last year's actuals + x%" for one department (null = company level). */
export async function startFromPriorYear(ctx: BudgetCtx, versionId: string, departmentId: string | null, growthBps: number): Promise<{ rows: number; annualCents: number; changed: number }> {
  if (!Number.isInteger(growthBps) || growthBps < -10000 || growthBps > 100000) throw new BudgetError('VALIDATION', 'Growth must be between −100% and 1,000%.');
  const version = await loadVersion(ctx.reader, versionId);
  await assertEditable(ctx, version, departmentId);
  const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
  const py = await pyActualsByAccount(ctx, version.locationId, version.fiscalYear, departmentId, byId);
  const cells: Array<{ accountId: string; periodNumber: number; amountCents: number }> = [];
  let annual = 0;
  if (py.size === 0) throw new BudgetError('VALIDATION', `No FY${version.fiscalYear - 1} actuals were posted to this ${departmentId ? 'department' : 'company'} — start from a template instead.`);
  for (const [accountId, months] of py) {
    const g = generate({ method: 'PY_GROWTH', growthBps }, { pyMonths: months });
    annual += g.annualCents;
    for (let k = 0; k < MONTHS; k++) cells.push({ accountId, periodNumber: k + 1, amountCents: g.months[k] });
    await upsertDriver(ctx, version, departmentId, accountId, { method: 'PY_GROWTH', growthBps }, g.annualCents, 'AUTO', null);
  }
  const changed = await writeCells(ctx, version, departmentId, cells, 'PRIOR_YEAR', { closedMonths: 'skip' });
  await logEvent(ctx, { locationId: version.locationId, versionId, kind: 'LINES_GENERATED', meta: { department_id: departmentId, start: 'PRIOR_YEAR_ACTUALS', growth_bps: growthBps, rows: py.size, annual_cents: annual } });
  return { rows: py.size, annualCents: annual, changed };
}
