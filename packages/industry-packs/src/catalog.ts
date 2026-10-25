/**
 * Pack registry and `extends` resolution.
 *
 * Merge semantics for `extends` (child over parent), applied to the raw manifest input before Zod
 * parsing so "omitted" and "empty" stay distinguishable:
 *   - child_only    identity and classifier inputs (key, version, name, tagline, tile, naics,
 *                   keywords, archetypes, sampleJob): never inherited.
 *   - shallow       records (vocabulary, modules, params, aiProfile): { ...parent, ...child }.
 *   - merge_by_key  approvalPolicies (by key) and fieldDefs (by object + jobType + key): parent
 *                   items first, a child item with the same key replaces it in place, new child
 *                   items are appended.
 *   - replace       the workspace shape (jobTypes, stageMachines, costCodes, priceBook, kpis,
 *                   questions) and the v2 lists (roles, docTemplates, checklists): the child's array
 *                   if it has one, otherwise the parent's.
 *   - shallow (v2)  nav and home per persona group, jobTabs per job type, mobile, schedule.
 * A child always resolves against the parent's latest version.
 */
import { PackManifestSchema, type PackManifest, type PackManifestInput } from './types';
import { PACK_MANIFESTS } from './packs';

export type MergePolicy = 'child_only' | 'shallow' | 'merge_by_key' | 'replace';

export const MERGE_POLICY: Record<keyof PackManifestInput, MergePolicy> = {
  key: 'child_only',
  version: 'child_only',
  extends: 'child_only',
  name: 'child_only',
  tagline: 'child_only',
  tile: 'child_only',
  naics: 'child_only',
  keywords: 'child_only',
  archetypes: 'child_only',
  sampleJob: 'child_only',
  vocabulary: 'shallow',
  modules: 'shallow',
  params: 'shallow',
  aiProfile: 'shallow',
  approvalPolicies: 'merge_by_key',
  fieldDefs: 'merge_by_key',
  jobTypes: 'replace',
  stageMachines: 'replace',
  costCodes: 'replace',
  priceBook: 'replace',
  kpis: 'replace',
  questions: 'replace',
  // manifest v2 experience slots
  roles: 'replace',
  nav: 'shallow',          // per persona group: a child's rail for a group replaces the parent's
  home: 'shallow',
  jobTabs: 'shallow',      // per job type; the parent's '*' set stays the fallback
  mobile: 'shallow',
  schedule: 'shallow',
  docTemplates: 'replace',
  checklists: 'replace',
};

export interface PackSummary {
  key: string;
  version: string;
  name: string;
  tagline: string;
  tile: { label: string; examples: string };
  archetypes: PackManifest['archetypes'];
  extends: string | null;
}

export class PackNotFoundError extends Error {
  constructor(key: string, version?: string) {
    super(`Unknown industry pack ${version ? `${key}@${version}` : key}`);
    this.name = 'PackNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const REGISTRY = new Map<string, PackManifestInput[]>();
for (const m of PACK_MANIFESTS) {
  const list = REGISTRY.get(m.key) ?? [];
  if (list.some((x) => x.version === m.version)) {
    throw new Error(`Duplicate pack version ${m.key}@${m.version}`);
  }
  list.push(m);
  list.sort((x, y) => compareSemver(y.version, x.version)); // newest first
  REGISTRY.set(m.key, list);
}

/** Keys in tile order (the order PACK_MANIFESTS lists them). */
export const CATALOG_KEYS: readonly string[] = [...new Set(PACK_MANIFESTS.map((m) => m.key))];

/** The raw (unresolved) manifest input for a key, latest version unless one is named. */
export function getPackInput(key: string, version?: string): PackManifestInput | undefined {
  const list = REGISTRY.get(key);
  if (!list) return undefined;
  return version ? list.find((x) => x.version === version) : list[0];
}

export function latestVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CATALOG_KEYS) out[key] = REGISTRY.get(key)![0].version;
  return out;
}

export function listVersions(key: string): string[] {
  return (REGISTRY.get(key) ?? []).map((x) => x.version);
}

export function isPackKey(key: string): boolean {
  return REGISTRY.has(key);
}

// ---------------------------------------------------------------------------
// extends resolution
// ---------------------------------------------------------------------------

type Keyed = Record<string, unknown>;

function mergeByKey<T>(parent: T[] | undefined, child: T[] | undefined, keyOf: (x: T) => string): T[] | undefined {
  if (parent === undefined && child === undefined) return undefined;
  const out: T[] = [...(parent ?? [])];
  const index = new Map(out.map((x, i) => [keyOf(x), i]));
  for (const item of child ?? []) {
    const k = keyOf(item);
    const at = index.get(k);
    if (at !== undefined) out[at] = item;
    else {
      index.set(k, out.length);
      out.push(item);
    }
  }
  return out;
}

const KEY_FNS: Partial<Record<keyof PackManifestInput, (x: Keyed) => string>> = {
  approvalPolicies: (x) => String(x.key),
  fieldDefs: (x) => `${String(x.object)}:${String(x.jobType ?? '')}:${String(x.key)}`,
};

/** Merge one child input over one (already resolved) parent input. */
export function mergeManifestInputs(parent: PackManifestInput, child: PackManifestInput): PackManifestInput {
  const out: Keyed = {};
  for (const field of Object.keys(MERGE_POLICY) as (keyof PackManifestInput)[]) {
    const policy = MERGE_POLICY[field];
    const p = (parent as Keyed)[field];
    const c = (child as Keyed)[field];
    let v: unknown;
    switch (policy) {
      case 'child_only':
        v = c;
        break;
      case 'shallow':
        v = p === undefined && c === undefined ? undefined : { ...((p as Keyed) ?? {}), ...((c as Keyed) ?? {}) };
        break;
      case 'merge_by_key':
        v = mergeByKey(p as Keyed[] | undefined, c as Keyed[] | undefined, KEY_FNS[field]!);
        break;
      case 'replace':
        v = c !== undefined ? c : p;
        break;
    }
    if (v !== undefined) out[field] = v;
  }
  return out as PackManifestInput;
}

/**
 * Resolve `extends` for an input (walks the chain, detects cycles). `lookup` defaults to the
 * registry so tests can resolve ad-hoc manifests against published parents.
 */
export function resolveInput(
  input: PackManifestInput,
  lookup: (key: string) => PackManifestInput | undefined = (k) => getPackInput(k),
): PackManifestInput {
  const chain: PackManifestInput[] = [input];
  const seen = new Set<string>([input.key]);
  let cur = input;
  while (cur.extends) {
    if (seen.has(cur.extends)) throw new Error(`Pack extends cycle: ${[...seen, cur.extends].join(' → ')}`);
    const parent = lookup(cur.extends);
    if (!parent) throw new PackNotFoundError(cur.extends);
    seen.add(parent.key);
    chain.push(parent);
    cur = parent;
  }
  let acc = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) acc = mergeManifestInputs(acc, chain[i]);
  return acc;
}

/** The merged, unparsed input for a published pack (what validateManifest() should check). */
export function resolveManifestInput(key: string, version?: string): PackManifestInput {
  const input = getPackInput(key, version);
  if (!input) throw new PackNotFoundError(key, version);
  return resolveInput(input);
}

const RESOLVED = new Map<string, PackManifest>();

/** Resolved and Zod-parsed manifest (defaults applied). Throws on unknown key or invalid manifest. */
export function resolveManifest(key: string, version?: string): PackManifest {
  const input = getPackInput(key, version);
  if (!input) throw new PackNotFoundError(key, version);
  const cacheKey = `${input.key}@${input.version}`;
  const hit = RESOLVED.get(cacheKey);
  if (hit) return hit;
  const parsed = PackManifestSchema.parse(resolveInput(input));
  RESOLVED.set(cacheKey, parsed);
  return parsed;
}

/** Resolved manifest or undefined when the key/version is not published. */
export function getPack(key: string, version?: string): PackManifest | undefined {
  if (!getPackInput(key, version)) return undefined;
  return resolveManifest(key, version);
}

export function listPacks(): PackSummary[] {
  return CATALOG_KEYS.map((key) => {
    const m = resolveManifest(key);
    return {
      key: m.key,
      version: m.version,
      name: m.name,
      tagline: m.tagline,
      tile: m.tile,
      archetypes: m.archetypes,
      extends: m.extends ?? null,
    };
  });
}
