/**
 * maskMoney — defense in depth on top of RLS (spec §4). Pure and client-safe.
 *
 * Walks any JSON value and blanks (sets to null) every money figure the caller may not see:
 *   - the key's classes come from MONEY_KEYS for the declared object types (or the strict union);
 *   - a figure is kept only when the caller holds `projects.<class>:view` for EVERY class the key
 *     needs, at the row's company (`location_id` / `locationId` / `companyId` on the object or an
 *     ancestor), else at the request's company, else at any company;
 *   - money-looking keys in no list need both financials and contract_value (fail closed);
 *   - only numbers (and numeric strings — bigint over JSON) are blanked; arrays and objects are
 *     walked, never removed, so a key that names a list elsewhere can't wipe it.
 *
 * Blank = null, not a deleted key: it matches what the database's masked views return for the
 * same columns (spec §3 "null the column"), so the UI handles one shape for both.
 */
import type { Access, Grant } from './types';
import { MONEY_LIKE_KEY, metricClasses, rulesFor, type MaskRules, type MoneyClass, type MoneyObject } from './money-keys';

const VIEW: Readonly<Record<MoneyClass, Grant>> = {
  financials: 'projects.financials:view',
  contract_value: 'projects.contract_value:view',
  labor_rates: 'projects.labor_rates:view',
};
const BOTH: readonly MoneyClass[] = ['financials', 'contract_value'];
const NUMERIC = /^-?\d+(\.\d+)?$/;
const COMPANY_KEYS = ['location_id', 'locationId', 'companyId', 'company_id'] as const;

const ruleCache = new Map<string, MaskRules>();
function cachedRules(objects?: ReadonlyArray<MoneyObject>): MaskRules {
  const key = objects && objects.length ? [...objects].sort().join(',') : '*';
  let r = ruleCache.get(key);
  if (!r) ruleCache.set(key, (r = rulesFor(objects)));
  return r;
}

function holds(access: Access, cls: MoneyClass, companyId: string | null): boolean {
  const g = VIEW[cls];
  if (companyId) return (Object.hasOwn(access.byCompany, companyId) ? access.byCompany[companyId] : undefined)?.has(g) ?? false;
  return access.grants.has(g);
}

/** True when nothing could ever be masked for this caller (all money at every company). */
export function seesAllMoney(access: Access): boolean {
  const all = (s: ReadonlySet<Grant>) => s.has(VIEW.financials) && s.has(VIEW.contract_value) && s.has(VIEW.labor_rates);
  if (!all(access.grants)) return false;
  return Object.values(access.byCompany).every(all);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function isFigure(v: unknown): boolean {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMERIC.test(v));
}

export function maskMoney<T>(
  value: T,
  access: Access,
  companyId?: string | null,
  objects?: MoneyObject | ReadonlyArray<MoneyObject>,
): T {
  if (seesAllMoney(access)) return value;
  const rules = cachedRules(typeof objects === 'string' ? [objects] : objects);
  const allowed = new Map<string, boolean>(); // per (company, classes) memo inside one call

  const ok = (classes: readonly MoneyClass[], company: string | null): boolean => {
    const k = `${company ?? '*'}|${classes.join(',')}`;
    let r = allowed.get(k);
    if (r === undefined) allowed.set(k, (r = classes.every((c) => holds(access, c, company))));
    return r;
  };

  const walk = (v: unknown, company: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, company));
    if (!isPlainObject(v)) return v;
    let here = company;
    for (const ck of COMPANY_KEYS) {
      const c = Object.hasOwn(v, ck) ? v[ck] : undefined; // own keys only: never a polluted prototype
      if (typeof c === 'string' && c) { here = c; break; }
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) {
      if (isFigure(val)) {
        const classes = rules.money.get(key) ?? (!rules.public.has(key) && MONEY_LIKE_KEY.test(key) ? BOTH : null);
        out[key] = classes && !ok(classes, here) ? null : val;
      } else if (val !== null && typeof val === 'object') {
        out[key] = walk(val, here);
      } else {
        out[key] = val;
      }
    }
    return out;
  };

  return walk(value, companyId ?? null) as T;
}

/** A KPI signal may be shown: its metric is not money, or the caller holds what it needs. */
export function metricVisible(access: Access, metric: string, companyId?: string | null): boolean {
  const classes = metricClasses(metric);
  return !classes || classes.every((c) => holds(access, c, companyId ?? null));
}
