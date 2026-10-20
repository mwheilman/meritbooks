/** diffPlans(): what an upgrade or an edited answer would change, section by section. */
import type { WorkspacePlan } from './types';

export interface SectionDiff {
  added: string[];
  removed: string[];
  changed: { key: string; before: unknown; after: unknown }[];
}

export type DiffSection =
  | 'pack' | 'params' | 'vocabulary' | 'modules' | 'job_types' | 'stages' | 'transitions'
  | 'approval_policies' | 'cost_codes' | 'field_defs' | 'price_book' | 'kpis' | 'books_proposal';

export interface PlanDiff {
  identical: boolean;
  sections: Record<DiffSection, SectionDiff>;
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val
  ));
}

function diffRecords(a: Record<string, unknown>, b: Record<string, unknown>): SectionDiff {
  const out: SectionDiff = { added: [], removed: [], changed: [] };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, k);
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    if (inA && !inB) out.removed.push(k);
    else if (!inA && inB) out.added.push(k);
    else if (stable(a[k]) !== stable(b[k])) out.changed.push({ key: k, before: a[k], after: b[k] });
  }
  return out;
}

function byKey<T>(items: T[], keyOf: (x: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) out[keyOf(it)] = it;
  return out;
}

export function diffPlans(prev: WorkspacePlan, next: WorkspacePlan): PlanDiff {
  const sections: Record<DiffSection, SectionDiff> = {
    pack: diffRecords(
      { primary: prev.primary_pack, addons: prev.addon_packs },
      { primary: next.primary_pack, addons: next.addon_packs },
    ),
    params: diffRecords(prev.params, next.params),
    vocabulary: diffRecords(prev.vocabulary, next.vocabulary),
    modules: diffRecords(prev.modules, next.modules),
    job_types: diffRecords(byKey(prev.job_types, (j) => j.key), byKey(next.job_types, (j) => j.key)),
    stages: diffRecords(
      byKey(prev.stages, (s) => `${s.machine_key}:${s.stage_key}`),
      byKey(next.stages, (s) => `${s.machine_key}:${s.stage_key}`),
    ),
    transitions: diffRecords(
      byKey(prev.transitions, (t) => `${t.machine_key}:${t.from_stage}>${t.to_stage}`),
      byKey(next.transitions, (t) => `${t.machine_key}:${t.from_stage}>${t.to_stage}`),
    ),
    approval_policies: diffRecords(byKey(prev.approval_policies, (p) => p.key), byKey(next.approval_policies, (p) => p.key)),
    cost_codes: diffRecords(byKey(prev.cost_codes, (c) => c.code), byKey(next.cost_codes, (c) => c.code)),
    field_defs: diffRecords(
      byKey(prev.field_defs, (f) => `${f.object_type}:${f.job_type_key ?? ''}:${f.field_key}`),
      byKey(next.field_defs, (f) => `${f.object_type}:${f.job_type_key ?? ''}:${f.field_key}`),
    ),
    price_book: diffRecords(byKey(prev.price_book, (p) => p.code), byKey(next.price_book, (p) => p.code)),
    kpis: diffRecords(byKey(prev.kpis, (k) => k.key), byKey(next.kpis, (k) => k.key)),
    books_proposal: diffRecords(
      { ...prefix('cost_type:', prev.books_proposal.cost_type_roles), ...prefix('rev_rec:', prev.books_proposal.rev_rec_by_job_type) },
      { ...prefix('cost_type:', next.books_proposal.cost_type_roles), ...prefix('rev_rec:', next.books_proposal.rev_rec_by_job_type) },
    ),
  };
  return { identical: prev.plan_hash === next.plan_hash, sections };
}

function prefix(p: string, rec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [`${p}${k}`, v]));
}
