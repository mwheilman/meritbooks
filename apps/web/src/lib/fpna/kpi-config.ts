/**
 * FP&A dashboard — configurable KPI layout (pure, framework-free).
 *
 * The `/fpna` dashboard renders a fixed KPI strip today. This module lets a user
 * choose WHICH KPI tiles show and in WHAT ORDER, and pick a default period, then
 * persists that choice client-side (localStorage, keyed per user + active
 * company — see `kpiConfigStorageKey`). No schema, no server round-trip.
 *
 * The universe of selectable KPIs (`KPI_CATALOG`) is EXACTLY the set the
 * dashboard already computes deterministically from the owned GL in
 * `lib/fpna/dashboard.ts` (KPIs + runway + prior-period deltas). We never invent
 * a metric that isn't computable from `DashboardResponse`; the UI maps each id
 * back to its real figure. If a saved config references an id no longer in the
 * catalog (catalog shrank across a deploy), it is dropped gracefully.
 *
 * Everything here is pure: config in → config out. That keeps it exhaustively
 * unit-testable (serialize/deserialize, drop-unknown, apply-layout, reorder).
 */

// ── The KPI universe (mirrors what lib/fpna/dashboard.ts computes) ────────────

export type KpiId =
  | 'revenue'
  | 'grossProfit'
  | 'grossMargin'
  | 'cogs'
  | 'opex'
  | 'operatingIncome'
  | 'operatingMargin'
  | 'netIncome'
  | 'netMargin'
  | 'cash'
  | 'monthlyBurn'
  | 'runway'
  | 'ar'
  | 'ap'
  | 'workingCapital'
  | 'currentRatio';

export type KpiGroup = 'Profitability' | 'Liquidity & runway' | 'Balance sheet';

export interface KpiMeta {
  id: KpiId;
  /** Short tile label. */
  label: string;
  group: KpiGroup;
  /** One-line description shown in the customize picker. */
  description: string;
}

/**
 * Ordered catalog of every KPI the dashboard can render. Each entry has a 1:1
 * source in `DashboardResponse` (kpis / runway / deltas) — the UI owns that
 * mapping. Order here is the "natural" fallback order used when a config lists
 * ids in an unexpected sequence.
 */
export const KPI_CATALOG: readonly KpiMeta[] = [
  { id: 'revenue', label: 'Revenue', group: 'Profitability', description: 'Recognized revenue for the period.' },
  { id: 'grossProfit', label: 'Gross profit', group: 'Profitability', description: 'Revenue less cost of goods sold.' },
  { id: 'grossMargin', label: 'Gross margin', group: 'Profitability', description: 'Gross profit as a percent of revenue.' },
  { id: 'cogs', label: 'Cost of goods sold', group: 'Profitability', description: 'Direct cost of delivering revenue.' },
  { id: 'opex', label: 'Operating expenses', group: 'Profitability', description: 'Operating expense for the period.' },
  { id: 'operatingIncome', label: 'Operating income', group: 'Profitability', description: 'Gross profit less operating expenses.' },
  { id: 'operatingMargin', label: 'Operating margin', group: 'Profitability', description: 'Operating income as a percent of revenue.' },
  { id: 'netIncome', label: 'Net income', group: 'Profitability', description: 'Bottom-line profit after all income and expense.' },
  { id: 'netMargin', label: 'Net margin', group: 'Profitability', description: 'Net income as a percent of revenue.' },
  { id: 'cash', label: 'Cash', group: 'Liquidity & runway', description: 'Cash on hand as of period end.' },
  { id: 'monthlyBurn', label: 'Monthly burn', group: 'Liquidity & runway', description: 'Average monthly cash consumption.' },
  { id: 'runway', label: 'Runway', group: 'Liquidity & runway', description: 'Months of cash at the current burn rate.' },
  { id: 'ar', label: 'Accounts receivable', group: 'Balance sheet', description: 'Outstanding customer balances.' },
  { id: 'ap', label: 'Accounts payable', group: 'Balance sheet', description: 'Outstanding vendor balances.' },
  { id: 'workingCapital', label: 'Working capital', group: 'Balance sheet', description: 'Current assets less current liabilities.' },
  { id: 'currentRatio', label: 'Current ratio', group: 'Balance sheet', description: 'Current assets ÷ current liabilities.' },
] as const;

/** All known ids, in catalog order — the default "available" universe. */
export const KPI_IDS: readonly KpiId[] = KPI_CATALOG.map((m) => m.id);

const KPI_META_BY_ID: Record<string, KpiMeta> = Object.fromEntries(
  KPI_CATALOG.map((m) => [m.id, m]),
);

export function kpiMeta(id: KpiId): KpiMeta {
  return KPI_META_BY_ID[id];
}

// ── Config shape ──────────────────────────────────────────────────────────────

export const KPI_CONFIG_VERSION = 1 as const;

/** How far back the dashboard opens by default. 0 = current month, −1 = prior. */
export const MIN_PERIOD_OFFSET = -11;
export const MAX_PERIOD_OFFSET = 0;

export interface KpiDashboardConfig {
  version: typeof KPI_CONFIG_VERSION;
  /** Visible tiles, in render order. Only these render, in exactly this order. */
  visible: KpiId[];
  /** Default period offset in months from the current month (0..−11). */
  periodOffset: number;
}

/** The out-of-the-box tile set — mirrors the dashboard's current fixed strip. */
export const DEFAULT_VISIBLE: readonly KpiId[] = [
  'revenue',
  'grossMargin',
  'operatingIncome',
  'netIncome',
  'cash',
  'monthlyBurn',
  'runway',
  'ar',
  'ap',
  'currentRatio',
];

export function defaultConfig(): KpiDashboardConfig {
  return { version: KPI_CONFIG_VERSION, visible: [...DEFAULT_VISIBLE], periodOffset: 0 };
}

// ── Starter layouts (Rule 2 enhancement) ──────────────────────────────────────

export type LayoutId = 'controller' | 'cfo' | 'owner';

export interface LayoutMeta {
  id: LayoutId;
  label: string;
  description: string;
  visible: readonly KpiId[];
}

/**
 * Role-oriented starting points. A user applies one, then customizes — it is a
 * seed, not a lock. Every id is in the catalog, so all tiles compute for real.
 */
export const LAYOUTS: readonly LayoutMeta[] = [
  {
    id: 'controller',
    label: 'Controller',
    description: 'Operational detail: profit tiers, opex and the balance-sheet workings.',
    visible: ['revenue', 'grossMargin', 'opex', 'operatingIncome', 'netIncome', 'cash', 'ar', 'ap', 'workingCapital', 'currentRatio'],
  },
  {
    id: 'cfo',
    label: 'CFO',
    description: 'Strategic view: margins, profitability and liquidity runway.',
    visible: ['revenue', 'grossMargin', 'operatingIncome', 'operatingMargin', 'netIncome', 'netMargin', 'cash', 'runway'],
  },
  {
    id: 'owner',
    label: 'Owner',
    description: 'The essentials: top line, bottom line, cash and receivables.',
    visible: ['revenue', 'netIncome', 'cash', 'runway', 'ar', 'ap'],
  },
] as const;

const LAYOUT_BY_ID: Record<string, LayoutMeta> = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

/** Build a config from a starter layout (keeps the current period offset). */
export function applyLayout(layoutId: LayoutId, periodOffset = 0): KpiDashboardConfig {
  const layout = LAYOUT_BY_ID[layoutId];
  const visible = layout ? [...layout.visible] : [...DEFAULT_VISIBLE];
  return { version: KPI_CONFIG_VERSION, visible: sanitizeVisible(visible), periodOffset: clampOffset(periodOffset) };
}

// ── Sanitizing / normalizing ──────────────────────────────────────────────────

function clampOffset(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
  if (v > MAX_PERIOD_OFFSET) return MAX_PERIOD_OFFSET;
  if (v < MIN_PERIOD_OFFSET) return MIN_PERIOD_OFFSET;
  return v;
}

/**
 * Filter a list of candidate ids down to real, de-duplicated, currently-available
 * KPIs. This is the graceful-degradation path: unknown ids (a metric removed from
 * the catalog since the config was saved) are silently dropped.
 */
export function sanitizeVisible(
  ids: readonly unknown[],
  available: readonly KpiId[] = KPI_IDS,
): KpiId[] {
  const allow = new Set<string>(available);
  const seen = new Set<string>();
  const out: KpiId[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    if (!allow.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw as KpiId);
  }
  return out;
}

/**
 * Coerce anything (parsed JSON, partial object, garbage) into a valid config.
 * An empty visible set after sanitizing falls back to the default set so the
 * dashboard is never blank purely because the saved list went stale.
 */
export function normalizeConfig(
  raw: unknown,
  available: readonly KpiId[] = KPI_IDS,
): KpiDashboardConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<KpiDashboardConfig>;
  let visible = sanitizeVisible(Array.isArray(obj.visible) ? obj.visible : [], available);
  if (visible.length === 0) {
    visible = sanitizeVisible(DEFAULT_VISIBLE, available);
  }
  return {
    version: KPI_CONFIG_VERSION,
    visible,
    periodOffset: clampOffset(obj.periodOffset),
  };
}

// ── Serialize / deserialize ────────────────────────────────────────────────────

export function serializeConfig(config: KpiDashboardConfig): string {
  return JSON.stringify({
    version: KPI_CONFIG_VERSION,
    visible: config.visible,
    periodOffset: config.periodOffset,
  });
}

/**
 * Parse a stored string back into a valid config. Any parse error or stale/unknown
 * content degrades to the default (or the sanitized remainder), never throws.
 */
export function deserializeConfig(
  json: string | null | undefined,
  available: readonly KpiId[] = KPI_IDS,
): KpiDashboardConfig {
  if (!json) return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(json), available);
  } catch {
    return defaultConfig();
  }
}

// ── Mutations (all pure — return a new config) ─────────────────────────────────

/** Move an item within a list from index `from` to index `to` (pure). */
export function moveInArray<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Reorder a visible tile up (−1) or down (+1) by one slot. */
export function moveMetric(config: KpiDashboardConfig, id: KpiId, direction: -1 | 1): KpiDashboardConfig {
  const from = config.visible.indexOf(id);
  if (from === -1) return config;
  const to = from + direction;
  if (to < 0 || to >= config.visible.length) return config;
  return { ...config, visible: moveInArray(config.visible, from, to) };
}

/**
 * Toggle a metric's visibility. Turning one on appends it to the end (preserving
 * the user's existing order); turning one off removes it. Turning the LAST
 * visible tile off is refused — the dashboard always shows at least one tile.
 */
export function toggleMetric(
  config: KpiDashboardConfig,
  id: KpiId,
  available: readonly KpiId[] = KPI_IDS,
): KpiDashboardConfig {
  if (!available.includes(id)) return config;
  if (config.visible.includes(id)) {
    if (config.visible.length <= 1) return config;
    return { ...config, visible: config.visible.filter((v) => v !== id) };
  }
  return { ...config, visible: [...config.visible, id] };
}

export function setPeriodOffset(config: KpiDashboardConfig, offset: number): KpiDashboardConfig {
  return { ...config, periodOffset: clampOffset(offset) };
}

// ── Persistence key (per user + active company) ───────────────────────────────

/**
 * localStorage key, namespaced per user and active company so each person's
 * per-entity layout is independent. Consolidated view uses the literal company
 * segment passed by the caller (e.g. 'all').
 */
export function kpiConfigStorageKey(userId: string, companyId: string): string {
  const u = userId || 'anon';
  const c = companyId || 'all';
  return `meritbooks:fpna:kpi-config:v${KPI_CONFIG_VERSION}:${u}:${c}`;
}
