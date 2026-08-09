import { formatMoney } from '@meritbooks/shared';
import type { Cadence, SubStatus } from './subscription-editor';

export type CreepFlag = 'NEW' | 'PRICE_INCREASE' | 'DUPLICATE_CATEGORY' | 'STALE';

export interface Subscription {
  id: string;
  vendor_id: string | null;
  vendor_name: string;
  product: string | null;
  category: string | null;
  amount_cents: number | null;
  prior_amount_cents: number | null;
  billing_cadence: Cadence;
  first_seen_date: string | null;
  last_charged_date: string | null;
  next_renewal_date: string | null;
  status: SubStatus;
  auto_renews: boolean;
  notice_period_days: number | null;
  cancellation_terms: string | null;
  cancellation_method: string | null;
  notes: string | null;
  source: 'DETECTED' | 'MANUAL' | 'PARSED';
  creep_flags: CreepFlag[] | null;
  charge_count: number;
  cancellation_draft: string | null;
}

export interface RenewalDue {
  subscription: Subscription;
  daysUntilRenewal: number;
  daysUntilNoticeDeadline: number;
  noticeWindowPassed: boolean;
}

export interface TrendPoint {
  month: string;
  label: string;
  totalCents: number;
  count: number;
}

export interface PriceCreepItem {
  id: string;
  vendor_name: string;
  product: string | null;
  category: string | null;
  billing_cadence: Cadence;
  priorCents: number;
  currentCents: number;
  deltaCents: number;
  pct: number;
  annualizedDeltaCents: number;
  next_renewal_date: string | null;
  last_charged_date: string | null;
  status: SubStatus;
}

export interface SubsSummary {
  count: number;
  totalMonthlyCents: number;
  totalAnnualCents: number;
  newCount: number;
  priceIncreaseCount: number;
  duplicateCount: number;
  staleCount: number;
  renewalsDue: number;
  noticePassed: number;
  windowDays: number;
  asOf: string;
  trendMonths: number;
  trendDeltaCents: number;
  trendPct: number;
  priceCreepCount: number;
  annualizedCreepCents: number;
}

export interface SubsResponse {
  data: Subscription[];
  renewals: RenewalDue[];
  trend: TrendPoint[];
  priceCreep: PriceCreepItem[];
  summary: SubsSummary;
}

// ── Shared presentation helpers ────────────────────────────────────────────────

export const CADENCE_ANNUAL: Record<Cadence, number> = { MONTHLY: 12, QUARTERLY: 4, ANNUAL: 1, OTHER: 12 };
export const CADENCE_LABEL: Record<Cadence, string> = { MONTHLY: '/mo', QUARTERLY: '/qtr', ANNUAL: '/yr', OTHER: '' };

export const STATUS_STYLE: Record<SubStatus, string> = {
  DETECTED: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  UNDER_REVIEW: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  CANCELLING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CANCELLED: 'bg-slate-700/40 text-slate-400 border-slate-700',
  KEPT: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

export const FLAG_STYLE: Record<CreepFlag, { label: string; cls: string }> = {
  NEW: { label: 'New', cls: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  PRICE_INCREASE: { label: 'Price ↑', cls: 'bg-red-500/10 text-red-300 border-red-500/20' },
  DUPLICATE_CATEGORY: { label: 'Overlap', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  STALE: { label: 'Stale', cls: 'bg-slate-600/30 text-slate-300 border-slate-600' },
};

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function fmtCents(cents: number | null): string {
  return cents === null ? '—' : formatMoney(cents);
}

export function annualized(s: Subscription): number {
  return (s.amount_cents ?? 0) * CADENCE_ANNUAL[s.billing_cadence];
}

export function fmtPct(fraction: number): string {
  const sign = fraction > 0 ? '+' : '';
  return `${sign}${Math.round(fraction * 100)}%`;
}
