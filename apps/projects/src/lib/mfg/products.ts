/**
 * Parametric product library math (MFG-07). Mirrors pm._mfg5_eval / pm._mfg5_expand in migration 1125
 * exactly — the PGlite parity test expands the same product in both.
 *
 * Every component quantity is a linear formula of the parameters: a constant plus coefficients on
 * W, H, D (inches), W×H, W×D, H×D, doors, drawers and shelves — times the unit count. Costs are
 * integer cents rounded half-up per component (pm.fs_rdiv).
 */

export type CoefKey = 'const' | 'w' | 'h' | 'd' | 'wh' | 'wd' | 'hd' | 'doors' | 'drawers' | 'shelves';
export type Coef = Partial<Record<CoefKey, number>>;
export type ComponentKind = 'SHEET' | 'EDGEBAND' | 'HARDWARE' | 'LUMBER' | 'FINISH' | 'BUYOUT' | 'LABOR' | 'INSTALL' | 'FREIGHT';

export interface ParamDef {
  default?: number;
  min?: number;
  max?: number;
  label?: string;
}

export interface ProductComponent {
  kind: ComponentKind;
  key: string;
  description?: string;
  uom?: string;
  coef: Coef;
  /** Cost per unit of the component; LABOR falls back to the work center's minute rate. */
  unit_cost_cents?: number | null;
}

export interface ProductDef {
  params: Record<string, ParamDef>;
  components: ProductComponent[];
  price_coef: Coef;
  markup_pct: number | null;
}

export interface ExpandedComponent {
  kind: ComponentKind;
  key: string;
  description: string;
  uom: string;
  qty: number;
  cost_cents: number;
}

export interface Expansion {
  params: Record<string, number>;
  units: number;
  components: ExpandedComponent[];
  labor_minutes: number;
  install_hours: number;
  cost_cents: number;
  sell_cents: number;
}

export class ParamError extends Error {}

/** Half-up integer division of a (possibly fractional) cents amount, like pm.fs_rdiv(x, 1). */
export function roundCents(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function evalCoef(c: Coef, p: Record<string, number>): number {
  const g = (k: string) => (Number.isFinite(p[k]) ? (p[k] as number) : 0);
  return (c.const ?? 0) + (c.w ?? 0) * g('w') + (c.h ?? 0) * g('h') + (c.d ?? 0) * g('d')
    + (c.wh ?? 0) * g('w') * g('h') + (c.wd ?? 0) * g('w') * g('d') + (c.hd ?? 0) * g('h') * g('d')
    + (c.doors ?? 0) * g('doors') + (c.drawers ?? 0) * g('drawers') + (c.shelves ?? 0) * g('shelves');
}

const DEFAULT_UOM: Record<ComponentKind, string> = {
  LABOR: 'MIN', INSTALL: 'HR', SHEET: 'SHEET', EDGEBAND: 'LF', HARDWARE: 'EA', LUMBER: 'EA', FINISH: 'EA', BUYOUT: 'EA', FREIGHT: 'EA',
};

/**
 * Expand a product at the given parameters (`qty` = units). `laborMinuteCents` maps a work-center
 * code to its cost per minute and `materialCents` a material key to its last cost, for components
 * without their own unit cost.
 */
export function expandProduct(
  def: ProductDef,
  input: Record<string, number | undefined>,
  laborMinuteCents: Record<string, number> = {},
  materialCents: Record<string, number> = {},
): Expansion {
  const params: Record<string, number> = {};
  for (const [k, d] of Object.entries(def.params)) {
    const v = input[k] ?? d.default ?? 0;
    if (d.min != null && v < d.min) throw new ParamError(`${k} must be at least ${d.min}`);
    if (d.max != null && v > d.max) throw new ParamError(`${k} must be at most ${d.max}`);
    params[k] = v;
  }
  for (const [k, v] of Object.entries(input)) if (!(k in params) && k !== 'qty' && v != null) params[k] = v;
  const units = Math.max(input.qty ?? 1, 0);
  const components: ExpandedComponent[] = [];
  let cost = 0;
  let labor = 0;
  let install = 0;
  for (const c of def.components) {
    const qty = r4(Math.max(evalCoef(c.coef ?? {}, params), 0) * units);
    if (qty === 0) continue;
    const unit = c.unit_cost_cents ?? (c.kind === 'LABOR' ? laborMinuteCents[c.key] : c.kind === 'INSTALL' || c.kind === 'FREIGHT' ? undefined : materialCents[c.key.toUpperCase()]) ?? 0;
    const line = roundCents(qty * unit);
    cost += line;
    if (c.kind === 'LABOR') labor += qty;
    if (c.kind === 'INSTALL') install += qty;
    components.push({ kind: c.kind, key: c.key, description: c.description ?? c.key, uom: c.uom ?? DEFAULT_UOM[c.kind], qty, cost_cents: line });
  }
  const hasPrice = Object.keys(def.price_coef ?? {}).length > 0;
  const sell = hasPrice ? roundCents(Math.max(evalCoef(def.price_coef, params), 0) * units)
    : def.markup_pct != null ? roundCents(cost * (1 + def.markup_pct)) : 0;
  return { params, units, components, labor_minutes: labor, install_hours: install, cost_cents: cost, sell_cents: sell };
}
