/**
 * /cash client types — the JSON the /api/cash/* routes return (types only; the server modules are
 * never bundled into the client) — plus small display helpers.
 */
import { compactMoney, money } from '@meritbooks/merit-ui';
import type { WorkspaceForecast, CompanyPosition } from '@/lib/cash/forecast/service';
import type { ForecastItem, Category } from '@/lib/cash/forecast/types';
import type { ScopeForecast, ForecastWeek } from '@/lib/cash/forecast/engine';
import type { AccuracyReport, AccuracyGroup } from '@/lib/cash/forecast/accuracy';
import type { HistoryPoint, RunwayResult } from '@/lib/cash/forecast/history';
import type { ScenarioRow } from '@/lib/cash/forecast/load';
import type { AvailableLine } from '@/lib/cash/forecast/liquidity';
import type { CompanySettings } from '@/lib/cash/forecast/assemble';

export type { WorkspaceForecast, CompanyPosition, ForecastItem, Category, ScopeForecast, ForecastWeek, AccuracyReport, AccuracyGroup, HistoryPoint, ScenarioRow, AvailableLine, CompanySettings };

export type CashTab = 'position' | 'forecast' | 'scenarios' | 'accuracy' | 'settings';
export const CASH_TABS: readonly CashTab[] = ['position', 'forecast', 'scenarios', 'accuracy', 'settings'];

export interface GovernanceNote {
  audience: 'finance' | 'other';
  banner: { tone: 'warn'; text: string } | null;
  footnote: string;
}

export interface ForecastResponse extends WorkspaceForecast {
  scope: { locationId: string | null; companyIds: string[]; companies: Array<{ id: string; name: string }> };
  governance: GovernanceNote | null;
}

export interface HistoryResponse {
  points: HistoryPoint[];
  summary: { startCents: number | null; endCents: number | null; changeCents: number | null; minCents: number | null; maxCents: number | null; lastDiffCents: number | null };
  grain: 'day' | 'week' | 'month';
  bankAccountCount: number;
  bankTxnCount: number;
  withheld: number;
  today: string;
  governance: GovernanceNote | null;
}

export interface MetricSeries {
  key: string;
  name: string;
  current: number | null;
  reason: string | null;
  points: Array<{ month: string; value: number | null; preliminary: boolean }>;
}

export interface MetricsResponse {
  today: string;
  runway: RunwayResult & { monthEnds: Array<{ date: string; cents: number | null }> };
  liquidity: WorkspaceForecast['liquidity'];
  openingBasis: 'BOOK' | 'BANK_FEED';
  forecast: { netCents: number; lowPoint: ScopeForecast['lowPoint']; closingCents: number };
  ccc: Record<string, MetricSeries | null> | null;
  cccError: string | null;
  governance: GovernanceNote | null;
}

export interface AccuracyResponse extends AccuracyReport {
  groups: Record<AccuracyGroup, string>;
  /** Opening / closing are null when the anchor date's books are not released to the reader (governance). */
  snapshots: Array<{ anchorDate: string; openingCents: number | null; closingCents: number | null; source: string; createdAt: string | null }>;
  today: string;
  governance: GovernanceNote | null;
}

export interface ScenariosResponse {
  scenarios: ScenarioRow[];
  companies: Array<{ id: string; name: string }>;
}

export interface ManualItem {
  id: string;
  companyId: string;
  scenarioId: string | null;
  direction: 'IN' | 'OUT';
  category: Category;
  label: string;
  expectedDate: string;
  amountCents: number;
  probabilityBps: number;
  recurrence: 'NONE' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY';
  recurrenceEnd: string | null;
  counterpartyCompanyId: string | null;
  accountId: string | null;
  note: string | null;
  isActive: boolean;
  updatedAt: string | null;
}

export interface SettingsResponse {
  companies: Array<{ id: string; name: string; settings: CompanySettings; locationMinimumCents: number }>;
  lines: AvailableLine[];
  configuredLines: Array<{ id: string; location_id: string; instrument_id: string | null; name: string; commitment_cents: number; borrowing_base_cents: number | null; drawn_cents: number | null; as_of_date: string | null; note: string | null }>;
  instruments: Array<{ id: string; name: string; location_id: string | null; instrument_type: string | null }>;
}

/** "$1,234" — whole dollars for the cash screens (cents shown in drills). */
export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return money(cents, { decimals: 0, symbol: '$', sign: 'minus' });
}

export function usdCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return money(cents, { symbol: '$', sign: 'minus' });
}

export function usdShort(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return compactMoney(cents, { symbol: '$', sign: 'minus' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19" */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

/** "Mon Oct 19" */
export function weekdayLabel(iso: string): string {
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${dow} ${dayLabel(iso)}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${String(y).slice(2)}`;
}

export function pctLabel(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return 'within the hour';
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export const CERTAINTY_WORD: Record<ForecastItem['certainty'], string> = { COMMITTED: 'Committed', EXPECTED: 'Expected', ESTIMATED: 'Estimated' };

export const FLAG_WORD: Record<string, string> = {
  OVERDUE: 'Overdue',
  DISPUTED: 'Disputed',
  ON_HOLD: 'On hold',
  UNAPPROVED: 'Not approved',
  PAY_RUN: 'In pay run',
  SCHEDULED: 'Scheduled',
  DELAYED: 'Delayed (scenario)',
  HAIRCUT: 'Reduced (scenario)',
  GROWTH: 'Grown (scenario)',
  UNCONFIRMED: 'Unconfirmed',
};

/** Where an item's source document lives (drill-through). */
export function sourceHref(it: ForecastItem): string | null {
  const id = it.source.id;
  switch (it.source.kind) {
    case 'INVOICE':
      return id ? `/invoices?open=${id}` : '/invoices';
    case 'RECURRING_INVOICE':
      return '/invoices?tab=recurring';
    case 'BILL':
      return id ? `/bills?open=${id}` : '/bills';
    case 'PAYROLL_RUN':
    case 'PAY_SCHEDULE':
      return '/payroll';
    case 'DEBT':
      return id ? `/debt?open=${id}` : '/debt';
    case 'LEASE':
      return '/leases';
    case 'SUBSCRIPTION':
      return '/subscriptions';
    case 'SALES_TAX':
    case 'ESTIMATED_TAX':
      return '/tax';
    default:
      return null;
  }
}

export async function downloadCsv(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
