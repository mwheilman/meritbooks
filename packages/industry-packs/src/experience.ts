/**
 * Manifest v2 experience (PLT-01, PLT-03, PLT-05; UX seat §3a/§3b/§3d).
 *
 *   compileExperience(primary, addons)   the plan's `experience` section: roles, rails, homes, job
 *                                        tabs, field actions, schedule views, templates, checklists
 *   applyExperienceOverrides(exp, rows)  tenant deltas from pm.pack_overrides (RFC 6901 pointers
 *                                        under /experience/…); a delta that would break the shape is
 *                                        skipped and reported, never applied half-way
 *   navFor / homeFor / jobTabsFor / mobileActionsFor / scheduleViewFor / roleTitleFor
 *                                        pure resolvers the app reads
 *
 * Pure and client-safe (no node:crypto): the app imports it on server and client.
 */
import { z } from 'zod';
import {
  ANY_JOB_TYPE, DOC_TEMPLATES, HOME_WIDGETS, JOB_TAB_KINDS, MOBILE_ACTIONS, NAV_ITEMS, PERSONA_GROUPS,
  PERSONA_TEMPLATES, SCHEDULE_VIEWS,
  type HomeWidgetKey, type JobTabKind, type MobileActionKey, type PackManifest, type PersonaGroupKey,
  type PersonaTemplate, type PlanExperience, type PlanJobTab, type PlanJobTabSet, type PlanNavEntry,
  type ScheduleViewKey,
} from './types';

// ---------------------------------------------------------------------------
// Overrides (pm.pack_overrides rows)
// ---------------------------------------------------------------------------

export interface PackOverride {
  json_pointer: string;
  op: 'add' | 'replace' | 'remove';
  value?: unknown;
}

/**
 * Segments and keys an override may never name: they reach Object.prototype (prototype
 * pollution — e.g. /experience/__proto__/mask). Refused in the pointer and anywhere in the value;
 * the database refuses them too (pm.pack_overrides check, migration 1116).
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenKey(k: string): boolean {
  return FORBIDDEN_KEYS.has(k);
}

/** RFC 6901: "/a/b~1c" → ["a", "b/c"]. Throws on a malformed pointer or a forbidden segment. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`JSON pointer "${pointer}" must start with "/"`);
  return pointer
    .slice(1)
    .split('/')
    .map((seg) => {
      if (/~[^01]|~$/.test(seg)) throw new Error(`JSON pointer "${pointer}" has a bad escape`);
      const out = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      if (isForbiddenKey(out)) throw new Error(`JSON pointer "${pointer}" names a forbidden key "${out}"`);
      return out;
    });
}

/** Own-property read (never the prototype chain). */
export function own<V>(rec: Readonly<Record<string, V>> | null | undefined, key: string): V | undefined {
  return rec != null && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/**
 * Deep copy into null-prototype objects (arrays stay arrays). Throws when any key is forbidden,
 * so a value like {"__proto__": {...}} can never become a prototype.
 */
function safeClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => safeClone(x)) as T;
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(v as Record<string, unknown>)) {
    if (isForbiddenKey(k)) throw new Error(`Override value names a forbidden key "${k}"`);
    out[k] = safeClone((v as Record<string, unknown>)[k]);
  }
  return out as T;
}

/** Back to plain objects for callers (JSON round trip keeps only own data properties). */
function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function clone<T>(v: T): T {
  return safeClone(v);
}

/** Apply one RFC 6902-style op (add / replace / remove) at a pointer. Returns a new value; throws when the path does not fit. */
export function applyPatch<T>(doc: T, op: PackOverride): T {
  const path = parsePointer(op.json_pointer);
  if (path.length === 0) throw new Error('An override cannot replace the whole document');
  const root = safeClone(doc) as unknown;
  let parent = root as Record<string, unknown> | unknown[];
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next: unknown = Array.isArray(parent) ? parent[Number(seg)] : own(parent as Record<string, unknown>, seg);
    if (next === null || typeof next !== 'object') {
      if (op.op === 'add' && !Array.isArray(parent)) {
        const created = Object.create(null) as Record<string, unknown>;
        (parent as Record<string, unknown>)[seg] = created;
        parent = created;
        continue;
      }
      throw new Error(`Path ${op.json_pointer} does not exist`);
    }
    parent = next as Record<string, unknown> | unknown[];
  }
  const last = path[path.length - 1];
  if (Array.isArray(parent)) {
    const idx = last === '-' ? parent.length : Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length || (op.op !== 'add' && idx >= parent.length)) {
      throw new Error(`Index ${last} is out of range at ${op.json_pointer}`);
    }
    if (op.op === 'add') parent.splice(idx, 0, clone(op.value));
    else if (op.op === 'replace') parent[idx] = clone(op.value);
    else parent.splice(idx, 1);
  } else {
    const obj = parent as Record<string, unknown>;
    if (op.op === 'remove') {
      if (!Object.hasOwn(obj, last)) throw new Error(`Nothing to remove at ${op.json_pointer}`);
      delete obj[last];
    } else {
      if (op.op === 'replace' && !Object.hasOwn(obj, last)) throw new Error(`Nothing to replace at ${op.json_pointer}`);
      obj[last] = clone(op.value);
    }
  }
  return plain(root) as T;
}

// ---------------------------------------------------------------------------
// Shape check for a compiled experience (guards tenant overrides)
// ---------------------------------------------------------------------------

const Group = z.enum(PERSONA_GROUPS);
const Lbl = z.string().min(1).max(40).nullable();

export const PlanExperienceSchema = z.object({
  roles: z.array(z.object({ title: z.string().min(1).max(40), template: z.enum(PERSONA_TEMPLATES) })),
  nav: z.record(Group, z.array(z.object({ item: z.enum(NAV_ITEMS), label: Lbl })).min(1)),
  home: z.record(Group, z.array(z.enum(HOME_WIDGETS)).min(1)),
  job_tabs: z.record(z.string(), z.object({
    tabs: z.array(z.object({ tab: z.enum(JOB_TAB_KINDS), label: Lbl })).min(1),
    default_tab: z.enum(JOB_TAB_KINDS),
  }).refine((s) => s.tabs.some((t) => t.tab === s.default_tab), 'default_tab must be one of the tabs')),
  mobile_actions: z.record(Group, z.record(z.string(), z.array(z.enum(MOBILE_ACTIONS)).min(1))),
  kiosk: z.boolean(),
  schedule_views: z.object({
    job: z.record(z.string(), z.enum(SCHEDULE_VIEWS)),
    multi_job: z.enum(SCHEDULE_VIEWS),
    by_group: z.record(Group, z.enum(SCHEDULE_VIEWS)),
  }),
  doc_templates: z.array(z.enum(DOC_TEMPLATES)),
  checklists: z.array(z.object({ key: z.string().min(2), label: z.string().min(1).max(60), job_types: z.array(z.string()).nullable() })),
  sources: z.record(z.string(), z.string()),
});

export interface OverrideResult {
  experience: PlanExperience;
  applied: PackOverride[];
  skipped: { override: PackOverride; reason: string }[];
}

export const EXPERIENCE_POINTER_ROOT = '/experience';

/**
 * Layer tenant deltas onto a compiled experience, in order. Only pointers under /experience/ are
 * read (other rows — /modules/…, /vocabulary/… — belong to other layers and are ignored here).
 * Each delta is all-or-nothing: if the result no longer has the experience shape, it is skipped.
 */
export function applyExperienceOverrides(exp: PlanExperience, overrides: ReadonlyArray<PackOverride> | null | undefined): OverrideResult {
  let cur = exp;
  const applied: PackOverride[] = [];
  const skipped: OverrideResult['skipped'] = [];
  for (const o of overrides ?? []) {
    if (!o || typeof o.json_pointer !== 'string' || !o.json_pointer.startsWith(`${EXPERIENCE_POINTER_ROOT}/`)) continue;
    if (o.op !== 'add' && o.op !== 'replace' && o.op !== 'remove') {
      skipped.push({ override: o, reason: `Unknown op "${String(o.op)}"` });
      continue;
    }
    try {
      const next = applyPatch({ experience: cur }, o).experience;
      const ok = PlanExperienceSchema.safeParse(next);
      if (!ok.success) {
        skipped.push({ override: o, reason: ok.error.issues[0]?.message ?? 'Breaks the experience shape' });
        continue;
      }
      // the parsed copy: only the keys the schema knows, as plain JSON data
      cur = plain(ok.data) as PlanExperience;
      applied.push(o);
    } catch (err) {
      skipped.push({ override: o, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { experience: cur, applied, skipped };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

type NavEntryIn = NonNullable<PackManifest['nav']>[PersonaGroupKey];
type TabSetIn = NonNullable<PackManifest['jobTabs']>[string];

function navEntries(list: NavEntryIn | undefined): PlanNavEntry[] {
  return (list ?? []).map((e) => (typeof e === 'string' ? { item: e, label: null } : { item: e.item, label: e.label }));
}

function tabSet(s: TabSetIn): PlanJobTabSet {
  const tabs: PlanJobTab[] = s.tabs.map((e) => (typeof e === 'string' ? { tab: e, label: null } : { tab: e.tab, label: e.label }));
  return { tabs, default_tab: s.defaultTab ?? tabs[0]!.tab };
}

function entries<K extends string, V>(r: Partial<Record<K, V>> | undefined): Array<[K, V]> {
  return Object.entries(r ?? {}).filter(([, v]) => v !== undefined) as Array<[K, V]>;
}

function emptyExperience(): PlanExperience {
  return {
    roles: [],
    nav: {},
    home: {},
    job_tabs: {},
    mobile_actions: {},
    kiosk: false,
    schedule_views: { job: {}, multi_job: 'calendar', by_group: {} },
    doc_templates: [],
    checklists: [],
    sources: {},
  };
}

/** One pack's experience, limited to the job types being installed (all of the pack's when omitted). */
export function experienceOf(m: PackManifest, jobTypeKeys?: ReadonlyArray<string>): PlanExperience {
  const included = new Set(jobTypeKeys ?? m.jobTypes.map((j) => j.key));
  const keep = (k: string) => k === ANY_JOB_TYPE || included.has(k);
  const out = emptyExperience();
  out.roles = (m.roles ?? []).map((r) => ({ title: r.title, template: r.template }));
  for (const [g, list] of entries(m.nav)) out.nav[g] = navEntries(list);
  for (const [g, list] of entries(m.home)) out.home[g] = [...list];
  for (const [k, s] of Object.entries(m.jobTabs ?? {})) if (keep(k)) out.job_tabs[k] = tabSet(s);
  for (const [g, byJt] of entries(m.mobile?.actions)) {
    const rec: Record<string, MobileActionKey[]> = {};
    for (const [k, acts] of Object.entries(byJt)) if (keep(k)) rec[k] = [...acts];
    if (Object.keys(rec).length) out.mobile_actions[g] = rec;
  }
  out.kiosk = m.mobile?.kiosk ?? false;
  if (m.schedule) {
    for (const [k, v] of Object.entries(m.schedule.job)) if (keep(k)) out.schedule_views.job[k] = v;
    out.schedule_views.multi_job = m.schedule.multiJob;
    for (const [g, v] of entries(m.schedule.byGroup)) out.schedule_views.by_group[g] = v;
  }
  out.doc_templates = [...(m.docTemplates ?? [])];
  out.checklists = (m.checklists ?? [])
    .map((c) => ({ key: c.key, label: c.label, job_types: c.jobTypes ? c.jobTypes.filter((k) => included.has(k)) : null }))
    .filter((c) => c.job_types === null || c.job_types.length > 0);
  for (const jt of m.jobTypes) if (included.has(jt.key)) out.sources[jt.key] = m.key;
  return out;
}

export interface ExperiencePart {
  manifest: PackManifest;
  /** Job types this pack contributes (after answers). Omit = all of the pack's. */
  jobTypeKeys?: ReadonlyArray<string>;
}

/**
 * Primary pack's experience, plus each add-on's per-job-type slots for the job types it brings
 * (an HVAC company with residential_remodel installs: install jobs get remodel tabs), plus the
 * add-on's rail items appended to each group the primary defines (union, primary order first).
 */
export function compileExperience(primary: ExperiencePart, addons: ReadonlyArray<ExperiencePart> = []): PlanExperience {
  const out = experienceOf(primary.manifest, primary.jobTypeKeys);
  for (const a of addons) {
    const ex = experienceOf(a.manifest, a.jobTypeKeys);
    const fresh = Object.keys(ex.sources).filter((k) => !Object.hasOwn(out.sources, k));
    for (const k of fresh) {
      out.sources[k] = a.manifest.key;
      const tabs = own(ex.job_tabs, k) ?? own(ex.job_tabs, ANY_JOB_TYPE);
      if (tabs) out.job_tabs[k] = clone(tabs);
      const view = own(ex.schedule_views.job, k) ?? own(ex.schedule_views.job, ANY_JOB_TYPE);
      if (view) out.schedule_views.job[k] = view;
      for (const [g, byJt] of entries(ex.mobile_actions)) {
        const acts = own(byJt, k) ?? own(byJt, ANY_JOB_TYPE);
        if (acts) out.mobile_actions[g] = { ...(out.mobile_actions[g] ?? {}), [k]: [...acts] };
      }
    }
    for (const [g, list] of entries(ex.nav)) {
      const base = out.nav[g];
      if (!base) continue;
      for (const e of list) if (!base.some((x) => x.item === e.item)) base.push(e);
    }
    for (const r of ex.roles) if (!out.roles.some((x) => x.title.toLowerCase() === r.title.toLowerCase())) out.roles.push(r);
    for (const d of ex.doc_templates) if (!out.doc_templates.includes(d)) out.doc_templates.push(d);
    for (const c of ex.checklists) if (!out.checklists.some((x) => x.key === c.key)) out.checklists.push(c);
    out.kiosk = out.kiosk || ex.kiosk;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolvers (pure; the app reads these)
// ---------------------------------------------------------------------------

/** The pack's rail for a persona group, or null (the app keeps its built-in rail). */
export function navFor(exp: PlanExperience | null | undefined, group: PersonaGroupKey): PlanNavEntry[] | null {
  const list = own(exp?.nav, group);
  return list && list.length ? list : null;
}

export function homeFor(exp: PlanExperience | null | undefined, group: PersonaGroupKey): HomeWidgetKey[] | null {
  const list = own(exp?.home, group);
  return list && list.length ? list : null;
}

/** Tabs for a job type: its own set, else the pack's '*' set, else null (module-driven tabs). */
export function jobTabsFor(exp: PlanExperience | null | undefined, jobTypeKey: string): PlanJobTabSet | null {
  if (!exp) return null;
  return own(exp.job_tabs, jobTypeKey) ?? own(exp.job_tabs, ANY_JOB_TYPE) ?? null;
}

export function mobileActionsFor(exp: PlanExperience | null | undefined, group: PersonaGroupKey, jobTypeKey?: string | null): MobileActionKey[] {
  const byJt = own(exp?.mobile_actions, group);
  if (!byJt) return [];
  return (jobTypeKey ? own(byJt, jobTypeKey) : undefined) ?? own(byJt, ANY_JOB_TYPE) ?? [];
}

export function scheduleViewFor(exp: PlanExperience | null | undefined, jobTypeKey: string): ScheduleViewKey | null {
  if (!exp) return null;
  return own(exp.schedule_views.job, jobTypeKey) ?? own(exp.schedule_views.job, ANY_JOB_TYPE) ?? null;
}

export function multiJobViewFor(exp: PlanExperience | null | undefined, group: PersonaGroupKey): ScheduleViewKey | null {
  if (!exp) return null;
  return own(exp.schedule_views.by_group, group) ?? exp.schedule_views.multi_job;
}

/** First industry title for a template ("Technician" for projects_labor in field_service). */
export function roleTitleFor(exp: PlanExperience | null | undefined, template: PersonaTemplate): string | null {
  return exp?.roles.find((r) => r.template === template)?.title ?? null;
}

/** Every title that maps to a template (role chips on the Team page and in onboarding). */
export function roleTitlesFor(exp: PlanExperience | null | undefined, template: PersonaTemplate): string[] {
  return (exp?.roles ?? []).filter((r) => r.template === template).map((r) => r.title);
}

export type { JobTabKind };
