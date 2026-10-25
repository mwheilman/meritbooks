/**
 * validateManifest(): Zod parse, then the semantic checks a schema cannot express. A manifest that
 * passes can be compiled with any valid answers and produces a plan the database can apply.
 */
import {
  ACCOUNT_ROLE_HINTS, ANY_JOB_TYPE, BILLING_MODES, MODULES, PackManifestSchema, VOCAB_KEYS,
  type PackManifest,
} from './types';
import { APPROVAL_ROLES, BANNED_WORDS_RE, RETAINAGE_BILLING_MODES, WELL_KNOWN_PARAMS } from './constants';
import { getMetric } from './metrics';
import { VOCAB_PAIRS } from './vocab';
import { applyEffects, includedJobTypes, isValidAnswer, resolveAnswers } from './effects';
import { tokenize } from './text';

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; manifest: PackManifest; issues: [] }
  | { ok: false; manifest?: PackManifest; issues: ValidationIssue[] };

const DIGITS_ONLY = /^\d+$/;
const FOUR_DIGIT = /\b[1-9]\d{3}\b/;
const ACCOUNT_TEXT = /\b(gl|account|acct)\.?\s*(no\.?|number|#)?\s*\d{3,}/i;

/** Paths where a digits-only string is legitimate (NAICS, cost/price codes, semver parts). */
function digitsAllowed(path: string): boolean {
  return (
    /^naics\[\d+\]$/.test(path)
    || /^costCodes\[\d+\]\.(code|parent)$/.test(path)
    || /^priceBook\[\d+\]\.(code|costCode)$/.test(path)
    || /^sampleJob\.budget\[\d+\]\.code$/.test(path)
  );
}

function walkStrings(value: unknown, path: string, visit: (path: string, key: string, v: unknown) => void, key = ''): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit, key));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, visit, k);
    return;
  }
  visit(path, key, value);
}

/** Checks that apply to the raw input, before defaults: no account numbers, no banned copy. */
function scanRaw(input: unknown, issues: ValidationIssue[]): void {
  walkStrings(input, '', (path, key, v) => {
    if (/account/i.test(key) && (typeof v === 'number' || (typeof v === 'string' && DIGITS_ONLY.test(v)))) {
      issues.push({ path, message: 'Packs never carry account numbers; use an account role hint' });
      return;
    }
    if (typeof v !== 'string') return;
    if (DIGITS_ONLY.test(v) && !digitsAllowed(path)) {
      issues.push({ path, message: `Digits-only value "${v}" looks like an account number` });
    }
    if (ACCOUNT_TEXT.test(v)) {
      issues.push({ path, message: `"${v}" references an account number` });
    }
    if (/roleHint$/.test(path) && FOUR_DIGIT.test(v)) {
      issues.push({ path, message: `roleHint "${v}" contains an account-like number` });
    }
    if (BANNED_WORDS_RE.test(v)) {
      issues.push({ path, message: `"${v}" uses a banned word (Merit voice)` });
    }
  });
}

function dupes(values: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) (seen.has(v) ? out : seen).add(v);
  return [...out];
}

export function validateManifest(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  scanRaw(input, issues);

  const parsed = PackManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const e of parsed.error.issues) issues.push({ path: e.path.join('.'), message: e.message });
    return { ok: false, issues };
  }
  const m = parsed.data;
  const add = (path: string, message: string) => issues.push({ path, message });

  // ---- identity / classifier
  for (const d of dupes(m.naics)) add('naics', `Duplicate NAICS ${d}`);
  const kwNorm = m.keywords.map((k) => tokenize(k.term).join(' '));
  m.keywords.forEach((k, i) => { if (kwNorm[i].length === 0) add(`keywords[${i}]`, `Keyword "${k.term}" has no tokens`); });
  for (const d of dupes(kwNorm)) add('keywords', `Duplicate keyword "${d}"`);
  if (m.extends === m.key) add('extends', 'A pack cannot extend itself');

  // ---- modules and vocabulary
  const moduleSet = new Set<string>(MODULES);
  for (const k of Object.keys(m.modules)) if (!moduleSet.has(k)) add(`modules.${k}`, `Unknown module "${k}"`);
  const vocabSet = new Set<string>(VOCAB_KEYS);
  for (const [k, v] of Object.entries(m.vocabulary)) {
    if (!vocabSet.has(k)) add(`vocabulary.${k}`, `Unknown vocabulary key "${k}"`);
    if (v.trim().length === 0 || v.length > 40) add(`vocabulary.${k}`, 'Vocabulary terms are 1–40 characters');
  }
  for (const [one, many] of VOCAB_PAIRS) {
    if ((one in m.vocabulary) !== (many in m.vocabulary)) {
      add('vocabulary', `Rename "${one}" and "${many}" together`);
    }
  }

  // ---- approval policies
  const policyKeys = new Set<string>();
  m.approvalPolicies.forEach((p, i) => {
    if (policyKeys.has(p.key)) add(`approvalPolicies[${i}]`, `Duplicate approval policy "${p.key}"`);
    policyKeys.add(p.key);
    let prev = -1;
    p.tiers.forEach((t, j) => {
      const at = `approvalPolicies[${i}].tiers[${j}]`;
      for (const r of t.roles) {
        if (!(APPROVAL_ROLES as readonly string[]).includes(r)) add(at, `Unknown approval role "${r}"`);
      }
      if (t.count > t.roles.length) add(at, 'count exceeds the number of roles');
      if (t.maxCents === null) {
        if (j !== p.tiers.length - 1) add(at, 'Only the last tier may be unbounded');
      } else {
        if (t.maxCents <= prev) add(at, 'Tiers must ascend by maxCents');
        prev = t.maxCents;
      }
    });
    if (p.tiers[p.tiers.length - 1].maxCents !== null) {
      add(`approvalPolicies[${i}]`, 'The last tier must be unbounded (maxCents: null) so every amount has an approver');
    }
  });

  // ---- stage machines
  const machines = new Map(m.stageMachines.map((sm) => [sm.key, sm]));
  for (const d of dupes(m.stageMachines.map((s) => s.key))) add('stageMachines', `Duplicate stage machine "${d}"`);
  m.stageMachines.forEach((sm, i) => {
    const at = `stageMachines[${i}]`;
    const stageKeys = sm.stages.map((s) => s.key);
    for (const d of dupes(stageKeys)) add(at, `Duplicate stage "${d}"`);
    const stages = new Map(sm.stages.map((s) => [s.key, s]));
    const initial = stages.get(sm.initial);
    if (!initial) {
      add(`${at}.initial`, `Initial stage "${sm.initial}" does not exist`);
      return;
    }
    if (initial.terminal) add(`${at}.initial`, 'The initial stage cannot be terminal');
    if (initial.coreStatus !== 'BID' && initial.coreStatus !== 'ACTIVE') add(`${at}.initial`, 'The initial stage must map to BID or ACTIVE');
    sm.stages.forEach((s, j) => {
      if (s.terminal && !['COMPLETE', 'CLOSED', 'CANCELLED'].includes(s.coreStatus)) {
        add(`${at}.stages[${j}]`, `Terminal stage "${s.key}" must map to COMPLETE, CLOSED or CANCELLED`);
      }
      if (!s.terminal && (s.coreStatus === 'CLOSED' || s.coreStatus === 'CANCELLED')) {
        add(`${at}.stages[${j}]`, `Non-terminal stage "${s.key}" cannot map to ${s.coreStatus}`);
      }
    });
    const out = new Map<string, string[]>(stageKeys.map((k) => [k, []]));
    const inc = new Map<string, string[]>(stageKeys.map((k) => [k, []]));
    const pairs = new Set<string>();
    sm.transitions.forEach((t, j) => {
      const tp = `${at}.transitions[${j}]`;
      if (!stages.has(t.from)) add(tp, `Transition from unknown stage "${t.from}"`);
      if (!stages.has(t.to)) add(tp, `Transition to unknown stage "${t.to}"`);
      if (t.from === t.to) add(tp, 'A transition cannot loop to the same stage');
      const pk = `${t.from}>${t.to}`;
      if (pairs.has(pk)) add(tp, `Duplicate transition ${t.from} → ${t.to}`);
      pairs.add(pk);
      if (new Set(t.guards).size !== t.guards.length) add(tp, 'Duplicate guard');
      if (t.approval && !policyKeys.has(t.approval)) add(tp, `Unknown approval policy "${t.approval}"`);
      if (stages.get(t.from)?.terminal) add(tp, `Terminal stage "${t.from}" cannot have outgoing transitions`);
      out.get(t.from)?.push(t.to);
      inc.get(t.to)?.push(t.from);
    });
    // reachability from initial
    const reach = new Set<string>([sm.initial]);
    const queue = [sm.initial];
    while (queue.length) for (const n of out.get(queue.shift()!) ?? []) if (!reach.has(n)) { reach.add(n); queue.push(n); }
    for (const k of stageKeys) if (!reach.has(k)) add(at, `Stage "${k}" is not reachable from "${sm.initial}"`);
    const terminals = sm.stages.filter((s) => s.terminal).map((s) => s.key);
    if (!terminals.some((k) => reach.has(k))) add(at, 'No terminal stage is reachable');
    if (!sm.stages.some((s) => s.terminal && s.coreStatus !== 'CANCELLED' && reach.has(s.key))) {
      add(at, 'No successful terminal stage (COMPLETE or CLOSED) is reachable');
    }
    // every stage can still finish
    const canFinish = new Set<string>(terminals);
    const back = [...terminals];
    while (back.length) for (const n of inc.get(back.shift()!) ?? []) if (!canFinish.has(n)) { canFinish.add(n); back.push(n); }
    for (const k of stageKeys) if (!canFinish.has(k)) add(at, `Stage "${k}" cannot reach a terminal stage`);
  });

  // ---- job types
  const jobTypes = new Map(m.jobTypes.map((j) => [j.key, j]));
  for (const d of dupes(m.jobTypes.map((j) => j.key))) add('jobTypes', `Duplicate job type "${d}"`);
  const usedMachines = new Set<string>();
  const usedArchetypes = new Set<string>();
  m.jobTypes.forEach((j, i) => {
    const at = `jobTypes[${i}]`;
    usedMachines.add(j.stageMachine);
    usedArchetypes.add(j.archetype);
    if (!machines.has(j.stageMachine)) add(`${at}.stageMachine`, `Unknown stage machine "${j.stageMachine}"`);
    if (!j.billingModes.includes(j.defaultBillingMode)) add(`${at}.defaultBillingMode`, `Default ${j.defaultBillingMode} is not an allowed billing mode`);
    if (new Set(j.billingModes).size !== j.billingModes.length) add(`${at}.billingModes`, 'Duplicate billing mode');
    if (!m.archetypes.includes(j.archetype)) add(`${at}.archetype`, `Archetype "${j.archetype}" is not declared by the pack`);
    for (const k of Object.keys(j.modules ?? {})) if (!moduleSet.has(k)) add(`${at}.modules.${k}`, `Unknown module "${k}"`);
    if (j.defaultRetainagePct !== undefined && !j.billingModes.some((b) => RETAINAGE_BILLING_MODES.includes(b))) {
      add(`${at}.defaultRetainagePct`, 'Retainage needs a progress, pay-app or draw billing mode');
    }
  });
  for (const sm of m.stageMachines) if (!usedMachines.has(sm.key)) add('stageMachines', `Stage machine "${sm.key}" is not used by any job type`);
  for (const a of m.archetypes) if (!usedArchetypes.has(a)) add('archetypes', `Archetype "${a}" is not used by any job type`);

  // ---- cost codes
  const codes = new Map(m.costCodes.map((c) => [c.code, c]));
  for (const d of dupes(m.costCodes.map((c) => c.code))) add('costCodes', `Duplicate cost code "${d}"`);
  m.costCodes.forEach((c, i) => {
    const at = `costCodes[${i}]`;
    if (/^[1-9]\d{3}$/.test(c.code)) add(`${at}.code`, `Cost code "${c.code}" looks like a GL account number`);
    if (c.parent !== undefined) {
      if (!codes.has(c.parent)) add(`${at}.parent`, `Parent "${c.parent}" does not exist`);
      if (c.parent === c.code) add(`${at}.parent`, 'A cost code cannot be its own parent');
    }
    if (c.roleHint && !(ACCOUNT_ROLE_HINTS as readonly string[]).includes(c.roleHint)) add(`${at}.roleHint`, 'Unknown role hint');
  });
  for (const c of m.costCodes) {
    const seen = new Set<string>();
    let cur: string | undefined = c.code;
    while (cur !== undefined) {
      if (seen.has(cur)) { add('costCodes', `Parent cycle at "${c.code}"`); break; }
      seen.add(cur);
      cur = codes.get(cur)?.parent;
    }
  }

  // ---- field defs
  const fieldKeys = m.fieldDefs.map((f) => `${f.object}:${f.jobType ?? ''}:${f.key}`);
  for (const d of dupes(fieldKeys)) add('fieldDefs', `Duplicate field "${d}"`);
  m.fieldDefs.forEach((f, i) => {
    const at = `fieldDefs[${i}]`;
    if (f.jobType && !jobTypes.has(f.jobType)) add(`${at}.jobType`, `Unknown job type "${f.jobType}"`);
    if (f.type === 'enum' && (!f.options || f.options.length < 2)) add(`${at}.options`, 'Enum fields need at least two options');
    if (f.type !== 'enum' && f.options) add(`${at}.options`, 'Only enum fields take options');
    if (f.options && new Set(f.options).size !== f.options.length) add(`${at}.options`, 'Duplicate option');
    if (f.label.trim().length === 0) add(`${at}.label`, 'Label is required');
  });

  // ---- price book
  for (const d of dupes(m.priceBook.map((p) => p.code))) add('priceBook', `Duplicate price book code "${d}"`);
  m.priceBook.forEach((p, i) => {
    if (p.code.length === 0 || p.name.length === 0 || p.unit.length === 0) add(`priceBook[${i}]`, 'code, name and unit are required');
    if (p.costCode !== undefined && !codes.has(p.costCode)) add(`priceBook[${i}].costCode`, `Unknown cost code "${p.costCode}"`);
  });

  // ---- KPIs
  for (const d of dupes(m.kpis.map((k) => k.key))) add('kpis', `Duplicate KPI "${d}"`);
  m.kpis.forEach((k, i) => {
    const def = getMetric(k.metric);
    if (!def) add(`kpis[${i}].metric`, `Unknown metric "${k.metric}" (not in the metric catalog)`);
    else if (def.goodDirection !== k.goodDirection) add(`kpis[${i}].goodDirection`, `Metric "${k.metric}" is good when ${def.goodDirection}`);
  });

  // ---- params
  const params = m.params;
  for (const [key, p] of Object.entries(params)) {
    const at = `params.${key}`;
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(key)) add(at, 'Param keys are lower_snake');
    switch (p.type) {
      case 'bool':
        if (typeof p.default !== 'boolean') add(at, 'bool param needs a boolean default');
        break;
      case 'percent': {
        const lo = p.min ?? 0;
        const hi = p.max ?? 1;
        if (lo < 0 || hi > 1 || lo > hi) add(at, 'percent params are fractions within 0..1');
        if (typeof p.default !== 'number' || p.default < lo || p.default > hi) add(at, 'percent default out of range');
        break;
      }
      case 'integer': {
        if (typeof p.default !== 'number' || !Number.isInteger(p.default)) add(at, 'integer param needs an integer default');
        else if ((p.min !== undefined && p.default < p.min) || (p.max !== undefined && p.default > p.max)) add(at, 'integer default out of range');
        break;
      }
      case 'enum':
        if (!p.options || p.options.length < 2) add(at, 'enum params need at least two options');
        else if (typeof p.default !== 'string' || !p.options.includes(p.default)) add(at, 'enum default must be one of the options');
        break;
    }
    const wk = (WELL_KNOWN_PARAMS as Record<string, string>)[key];
    if (wk && wk !== p.type) add(at, `"${key}" is a compiler param and must be ${wk}`);
  }
  if (params.retainage_pct && (params.retainage_pct.max ?? 1) > 0.2) add('params.retainage_pct', 'retainage_pct max is 0.2');

  // ---- questions
  for (const d of dupes(m.questions.map((q) => q.key))) add('questions', `Duplicate question "${d}"`);
  m.questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    const a = q.answer;
    if (!isValidAnswer(q, a.default)) add(`${at}.answer.default`, 'Default answer is not valid for its own options');
    if ((a.type === 'choice' || a.type === 'multi') && new Set(a.options.map((o) => o.value)).size !== a.options.length) {
      add(`${at}.answer.options`, 'Duplicate option value');
    }
    if (a.type === 'percent' && a.min > a.max) add(`${at}.answer`, 'min > max');
    q.effects.forEach((e, j) => {
      const ep = `${at}.effects[${j}]`;
      switch (e.kind) {
        case 'toggle_module': {
          if (a.type !== 'bool') { add(ep, 'toggle_module needs a bool answer'); break; }
          const result = a.default ? e.whenTrue : !e.whenTrue;
          if ((m.modules[e.module] ?? false) !== result) {
            add(ep, `Default answer turns "${e.module}" ${result ? 'on' : 'off'} but the pack default is ${m.modules[e.module] ? 'on' : 'off'}`);
          }
          break;
        }
        case 'set_param': {
          const p = params[e.param];
          if (!p) { add(ep, `Unknown param "${e.param}"`); break; }
          if (a.type === 'bool' && p.type !== 'bool') add(ep, `Param "${e.param}" must be bool for a bool answer`);
          if (a.type === 'percent') {
            if (p.type !== 'percent') add(ep, `Param "${e.param}" must be percent for a percent answer`);
            else if (a.min < (p.min ?? 0) || a.max > (p.max ?? 1)) add(ep, 'Answer range exceeds the param range');
          }
          if (a.type === 'choice') {
            if (p.type !== 'enum') add(ep, `Param "${e.param}" must be enum for a choice answer`);
            else if (!a.options.every((o) => p.options?.includes(o.value))) add(ep, 'Choice options must all be param options');
          }
          if (a.type === 'multi') add(ep, 'set_param cannot take a multi answer');
          if (p.default !== a.default) add(ep, `Default answer ${JSON.stringify(a.default)} differs from param default ${JSON.stringify(p.default)}`);
          break;
        }
        case 'enable_job_types': {
          for (const jt of e.jobTypes) if (!jobTypes.has(jt)) add(ep, `Unknown job type "${jt}"`);
          if (a.type === 'percent') add(ep, 'enable_job_types needs a bool, choice or multi answer');
          if ((a.type === 'choice' || a.type === 'multi') && !a.options.every((o) => e.jobTypes.includes(o.value))) {
            add(ep, 'Every option value must be one of the listed job types');
          }
          break;
        }
        case 'set_default_billing': {
          if (a.type !== 'choice') { add(ep, 'set_default_billing needs a choice answer'); break; }
          const modes = a.options.map((o) => o.value);
          for (const v of modes) if (!(BILLING_MODES as readonly string[]).includes(v)) add(ep, `"${v}" is not a billing mode`);
          if (e.jobType) {
            const jt = jobTypes.get(e.jobType);
            if (!jt) add(ep, `Unknown job type "${e.jobType}"`);
            else {
              for (const v of modes) if (!(jt.billingModes as string[]).includes(v)) add(ep, `"${v}" is not allowed for ${jt.key}`);
              if (jt.defaultBillingMode !== a.default) add(ep, `Default answer ${a.default} differs from ${jt.key}'s default ${jt.defaultBillingMode}`);
            }
          } else {
            for (const v of modes) if (!m.jobTypes.some((j) => (j.billingModes as string[]).includes(v))) add(ep, `No job type allows "${v}"`);
          }
          break;
        }
      }
    });
  });

  // ---- default plan and sample job
  let included: string[] = [];
  try {
    included = includedJobTypes(m, applyEffects(m, resolveAnswers(m, {})));
  } catch (err) {
    add('questions', `Default answers fail: ${(err as Error).message}`);
  }
  if (included.length === 0) add('jobTypes', 'Default answers leave no job types');

  const s = m.sampleJob;
  const sjt = jobTypes.get(s.jobType);
  if (!sjt) add('sampleJob.jobType', `Unknown job type "${s.jobType}"`);
  else {
    if (!included.includes(s.jobType)) add('sampleJob.jobType', `Sample job type "${s.jobType}" is off under default answers`);
    const sm = machines.get(sjt.stageMachine);
    if (sm && !sm.stages.some((st) => st.key === s.stage)) add('sampleJob.stage', `Stage "${s.stage}" is not in machine "${sm.key}"`);
    if (sm?.stages.find((st) => st.key === s.stage)?.terminal) add('sampleJob.stage', 'The sample job cannot start in a terminal stage');
  }
  s.budget.forEach((b, i) => { if (!codes.has(b.code)) add(`sampleJob.budget[${i}].code`, `Unknown cost code "${b.code}"`); });
  for (const d of dupes(s.budget.map((b) => b.code))) add('sampleJob.budget', `Duplicate budget code "${d}"`);
  const budgetTotal = s.budget.reduce((sum, b) => sum + b.amountCents, 0);
  if (budgetTotal > s.contractCents) add('sampleJob.budget', 'Sample budget exceeds the contract (negative margin)');
  s.tasks.forEach((t, i) => {
    if (t.offsetDays < 0) add(`sampleJob.tasks[${i}].offsetDays`, 'Task offsets start at day 0');
    if (t.title.trim().length === 0) add(`sampleJob.tasks[${i}].title`, 'Task title is required');
  });

  validateExperience(m, jobTypes, add);

  return issues.length === 0 ? { ok: true, manifest: m, issues: [] } : { ok: false, manifest: m, issues };
}

/** Manifest v2 slots: every job-type slot names a job type of this pack (or '*'), no duplicates, defaults in range. */
function validateExperience(m: PackManifest, jobTypes: ReadonlyMap<string, unknown>, add: (path: string, message: string) => void): void {
  const jtSlot = (path: string, k: string) => {
    if (k !== ANY_JOB_TYPE && !jobTypes.has(k)) add(path, `Unknown job type "${k}"`);
  };
  const titles = (m.roles ?? []).map((r) => r.title.toLowerCase());
  for (const d of dupes(titles)) add('roles', `Duplicate role title "${d}"`);

  for (const [g, list] of Object.entries(m.nav ?? {})) {
    const keys = (list ?? []).map((e) => (typeof e === 'string' ? e : e.item));
    for (const d of dupes(keys)) add(`nav.${g}`, `Rail item "${d}" is listed twice`);
  }
  for (const [g, list] of Object.entries(m.home ?? {})) {
    for (const d of dupes(list ?? [])) add(`home.${g}`, `Home widget "${d}" is listed twice`);
  }
  for (const [k, set] of Object.entries(m.jobTabs ?? {})) {
    jtSlot(`jobTabs.${k}`, k);
    const kinds = set.tabs.map((e) => (typeof e === 'string' ? e : e.tab));
    for (const d of dupes(kinds)) add(`jobTabs.${k}`, `Tab "${d}" is listed twice`);
    if (set.defaultTab && !kinds.includes(set.defaultTab)) add(`jobTabs.${k}.defaultTab`, `Default tab "${set.defaultTab}" is not in the tab list`);
  }
  for (const [g, byJt] of Object.entries(m.mobile?.actions ?? {})) {
    for (const [k, acts] of Object.entries(byJt ?? {})) {
      jtSlot(`mobile.actions.${g}.${k}`, k);
      for (const d of dupes(acts)) add(`mobile.actions.${g}.${k}`, `Action "${d}" is listed twice`);
    }
  }
  for (const k of Object.keys(m.schedule?.job ?? {})) jtSlot(`schedule.job.${k}`, k);
  for (const d of dupes(m.docTemplates ?? [])) add('docTemplates', `Template "${d}" is listed twice`);
  for (const d of dupes((m.checklists ?? []).map((c) => c.key))) add('checklists', `Duplicate checklist "${d}"`);
  (m.checklists ?? []).forEach((c, i) => (c.jobTypes ?? []).forEach((k) => jtSlot(`checklists[${i}].jobTypes`, k)));
}

/** Throwing variant for build-time use. */
export function assertValidManifest(input: unknown): PackManifest {
  const r = validateManifest(input);
  if (!r.ok) {
    throw new Error(`Invalid pack manifest:\n${r.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  }
  return r.manifest;
}
