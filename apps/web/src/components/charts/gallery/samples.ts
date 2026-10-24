/**
 * SAMPLE SHAPES for the internal chart-kit gallery ONLY.
 *
 * These are invented, deterministic figures that exercise every encoding
 * (preliminary, forecast, a missing month, a loss month, a bridge, a breach).
 * They are never shipped as real data: the gallery labels every card "Sample",
 * and no production screen imports this file (see gallery.test guard).
 * Money is integer cents; percents are fractions.
 */
import type { BridgeStep } from '../core/series';
import { trailingSum } from '../core/series';
import type { ChartPeriod, TimeSeriesData, Value } from '../core/types';

export const SAMPLE_BADGE = 'Sample';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** n monthly periods ending at (year, monthIndex). */
export function monthPeriods(n: number, endYear: number, endMonth: number): ChartPeriod[] {
  const out: ChartPeriod[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const total = endYear * 12 + endMonth - k;
    const y = Math.floor(total / 12);
    const m = total % 12;
    out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label: MONTHS[m], longLabel: `${MONTHS[m]} ${y}` });
  }
  return out;
}

/** Deterministic seasonal series (no Math.random — the gallery is stable). */
function seasonal(n: number, baseCents: number, growth: number, amp: number, phase = 0): number[] {
  return Array.from({ length: n }, (_, i) => {
    const season = 1 + amp * Math.sin(((i + phase) / 12) * Math.PI * 2);
    const wobble = 1 + 0.025 * Math.sin(i * 1.7 + phase);
    return Math.round(baseCents * (1 + growth) ** (i / 12) * season * wobble);
  });
}

// ─────────────────────────────────────────────────────────── revenue, 36 months
const P36 = monthPeriods(36, 2026, 7); // Sep 2023 – Aug 2026
const REV36 = seasonal(36, 820_000_00, 0.12, 0.16, 2);
const REV36_GAPPED: Value[] = REV36.map((v, i) => (P36[i].key === '2025-03' ? null : v));
const TTM36 = trailingSum(REV36_GAPPED, 12);

/** 24 months, Sep 2024 – Aug 2026; Aug 2026 preliminary; Mar 2025 not on file. */
export const SAMPLE_REVENUE: TimeSeriesData = {
  periods: P36.slice(12).map((p) => (p.key === '2026-08' ? { ...p, status: 'preliminary' as const } : p)),
  actual: REV36_GAPPED.slice(12),
  priorYear: REV36_GAPPED.slice(0, 24),
  budget: REV36.slice(12).map((v, i) => (i < 12 ? null : Math.round((v * 1.03) / 100_000) * 100_000)),
  ttm: TTM36.slice(12),
};

/** EBITDA by month with a loss month (Jan 2026). */
const EBITDA = seasonal(24, 96_000_00, 0.08, 0.6, 2).map((v, i) => (i === 16 ? -38_000_00 : v));
export const SAMPLE_EBITDA: TimeSeriesData = {
  periods: SAMPLE_REVENUE.periods,
  actual: EBITDA,
  priorYear: seasonal(24, 88_000_00, 0.06, 0.55, 2),
  budget: EBITDA.map((v, i) => (i < 12 ? null : Math.round((Math.abs(v) * 1.05 + 20_000_00) / 100_000) * 100_000)),
};

/** Gross margin % (fractions), with the same gap. */
export const SAMPLE_MARGIN: TimeSeriesData = {
  periods: SAMPLE_REVENUE.periods,
  actual: SAMPLE_REVENUE.actual.map((v, i) => (v === null ? null : 0.31 + 0.025 * Math.sin(i / 2.2) + i * 0.0009)),
  priorYear: SAMPLE_REVENUE.actual.map((_, i) => 0.3 + 0.02 * Math.sin(i / 2.2)),
};

/** Cash: 12 actual months then a 6-month forecast with a widening band (fan). */
const PC = monthPeriods(18, 2027, 1); // Sep 2025 – Feb 2027
const CASH_ACT = [2_140, 2_310, 2_060, 1_920, 2_250, 2_480, 2_390, 2_610, 2_540, 2_720, 2_660, 2_590].map((k) => k * 1000_00);
const CASH_FC = [2_480, 2_350, 2_420, 2_210, 2_060, 2_190].map((k) => k * 1000_00);
export const SAMPLE_CASH: TimeSeriesData = {
  periods: PC.map((p, i) => (i >= 12 ? { ...p, status: 'forecast' as const } : i === 11 ? { ...p, status: 'preliminary' as const } : p)),
  actual: [...CASH_ACT, ...CASH_FC],
  band: {
    lo: PC.map((_, i) => (i < 11 ? null : i === 11 ? CASH_ACT[11] : CASH_FC[i - 12] - (i - 11) * 95_000_00)),
    hi: PC.map((_, i) => (i < 11 ? null : i === 11 ? CASH_ACT[11] : CASH_FC[i - 12] + (i - 11) * 80_000_00)),
  },
};

/** DSO (days, lower is better). */
export const SAMPLE_DSO: Value[] = [44, 46, 43, 47, 49, 45, 42, 41, 44, 40, 39, 41];

// ─────────────────────────────────────────────────────────── bridge
export const SAMPLE_BRIDGE: BridgeStep[] = [
  { key: 'start', label: 'FY 2025 EBITDA', kind: 'start', value: 1_812_000_00 },
  { key: 'vol', label: 'Revenue volume', kind: 'delta', value: 684_000_00 },
  { key: 'price', label: 'Price / mix', kind: 'delta', value: 141_000_00 },
  { key: 'cogs', label: 'Materials', kind: 'delta', value: -212_000_00 },
  { key: 'gp', label: 'Gross profit', kind: 'subtotal', value: 0 },
  { key: 'pay', label: 'Payroll', kind: 'delta', value: -305_000_00 },
  { key: 'rent', label: 'Rent & occupancy', kind: 'delta', value: -48_000_00 },
  { key: 'mkt', label: 'Marketing', kind: 'delta', value: 37_000_00 },
  { key: 'end', label: 'FY 2026 EBITDA', kind: 'end', value: 2_109_000_00 },
];

// ─────────────────────────────────────────────────────────── companies
export const SAMPLE_COMPANIES = [
  { key: 'nw', label: 'Northwind Interiors', sub: 'Interiors' },
  { key: 'cd', label: 'Cedar Heating & Air', sub: 'HVAC' },
  { key: 'hb', label: 'Harbor Kitchen & Bath', sub: 'Remodel' },
  { key: 'pp', label: 'Prairie Power Equipment', sub: 'Dealer' },
  { key: 'ls', label: 'Lakeside Cabinets', sub: 'Manufacturing' },
  { key: 'ms', label: 'Meridian Homes', sub: 'Builder' },
  { key: 'qr', label: 'Quarry Ridge Electric', sub: 'Trades' },
  { key: 'ok', label: 'Oakline Plumbing', sub: 'Trades' },
] as const;

/** Revenue / EBITDA by company (cents) — EBITDA of Meridian is a loss. */
export const SAMPLE_COMPANY_REVENUE = [8_420_000_00, 6_910_000_00, 4_380_000_00, 3_950_000_00, 2_740_000_00, 2_210_000_00, 1_480_000_00, 930_000_00];
export const SAMPLE_COMPANY_EBITDA = [1_190_000_00, 1_020_000_00, 512_000_00, 486_000_00, 241_000_00, -164_000_00, 188_000_00, 96_000_00];
export const SAMPLE_COMPANY_GROWTH = [0.214, 0.162, 0.088, 0.041, 0.127, -0.06, 0.312, null];

// ─────────────────────────────────────────────────────────── AR aging
export const SAMPLE_AGING_BUCKETS = [
  { key: 'cur', label: 'Current' },
  { key: 'd30', label: '1–30' },
  { key: 'd60', label: '31–60' },
  { key: 'd90', label: '61–90' },
  { key: 'o90', label: 'Over 90' },
];
export const SAMPLE_AGING = [
  { key: 'acme', label: 'Acme Builders', values: [184_200_00, 62_400_00, 18_000_00, 0, 41_250_00] },
  { key: 'bolt', label: 'Bolt Property Group', values: [96_100_00, 44_800_00, 9_900_00, 12_300_00, 0] },
  { key: 'cove', label: 'Cove Hospitality', values: [71_500_00, 0, 22_600_00, 8_400_00, 19_800_00] },
  { key: 'dune', label: 'Dune Medical Offices', values: [58_000_00, 21_000_00, 0, 0, 0] },
  { key: 'elm', label: 'Elm Street Schools', values: [33_700_00, 12_200_00, 4_100_00, 2_600_00, 6_900_00] },
];

// ─────────────────────────────────────────────────────────── customers (concentration)
export const SAMPLE_CUSTOMERS = [
  { key: 'acme', label: 'Acme Builders', value: 2_140_000_00 },
  { key: 'bolt', label: 'Bolt Property Group', value: 1_380_000_00 },
  { key: 'cove', label: 'Cove Hospitality', value: 910_000_00 },
  { key: 'dune', label: 'Dune Medical Offices', value: 640_000_00 },
  { key: 'elm', label: 'Elm Street Schools', value: 520_000_00 },
  { key: 'fern', label: 'Fern Retail', value: 410_000_00 },
  { key: 'gale', label: 'Gale Logistics', value: 330_000_00 },
  { key: 'hawk', label: 'Hawk Storage', value: 210_000_00 },
  { key: 'iris', label: 'Iris Dental', value: 160_000_00 },
  { key: 'jade', label: 'Jade Apartments', value: 120_000_00 },
  { key: 'kilo', label: 'Kilo Fitness', value: 95_000_00 },
];

// ─────────────────────────────────────────────────────────── opex variance
export const SAMPLE_VARIANCE = [
  { key: 'rev', label: 'Revenue', actual: 8_412_000_00, plan: 8_250_000_00, direction: 'higher_is_better' as const },
  { key: 'mat', label: 'Materials', actual: 3_318_000_00, plan: 3_180_000_00, direction: 'lower_is_better' as const },
  { key: 'pay', label: 'Payroll', actual: 2_104_000_00, plan: 2_052_000_00, direction: 'lower_is_better' as const },
  { key: 'rent', label: 'Rent & occupancy', actual: 312_000_00, plan: 318_000_00, direction: 'lower_is_better' as const },
  { key: 'mkt', label: 'Marketing', actual: 141_000_00, plan: 175_000_00, direction: 'lower_is_better' as const },
  { key: 'it', label: 'Software & IT', actual: 96_000_00, plan: 88_000_00, direction: 'lower_is_better' as const },
  { key: 'ins', label: 'Insurance', actual: 128_000_00, plan: null, direction: 'lower_is_better' as const },
];
