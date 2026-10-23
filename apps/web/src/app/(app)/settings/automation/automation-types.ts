/**
 * Settings → Automation — response shapes + small pure formatters shared by the tabs.
 */

import type { DunningPolicy } from '@/lib/collections/dunning-policy';
import type { LateFeePolicy } from '@/lib/collections/late-fees';

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped';
export type JobState = 'running_normally' | 'failing' | 'disabled' | 'not_built' | 'never_run';
export type CountValue = number | string | boolean | null;

export interface JobView {
  key: string;
  label: string;
  description: string;
  scope: 'org' | 'platform';
  cron: string;
  defaultEnabled: boolean;
  implemented: boolean;
  owner: string;
  ownerCapability: string;
  postsToGl: boolean;
  autonomyFeature: string | null;
  enabled: boolean;
  effectiveCron: string;
  state: JobState;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  lastRun: {
    job_key: string;
    status: RunStatus;
    started_at: string;
    finished_at: string | null;
    items_processed: number;
    summary: string | null;
    error: string | null;
    trigger: string;
  } | null;
}

export interface RunView {
  id: string;
  job_key: string;
  slot_at: string;
  attempt: number;
  trigger: string;
  actor: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  items_processed: number;
  counts: Record<string, CountValue>;
  summary: string | null;
  error: string | null;
}

export interface RunsResponse {
  jobs: JobView[];
  runs: RunView[];
  nextCursor: string | null;
}

export interface CompanyOption {
  id: string;
  name: string;
  shortCode: string | null;
}

export interface PoliciesResponse {
  companies: CompanyOption[];
  incomeAccounts: Array<{ id: string; label: string; type: string }>;
  customers: Array<{ id: string; name: string }>;
  dunning: { tenant: DunningPolicy; tenantSaved: boolean; companies: Array<{ locationId: string; updatedAt: string; policy: DunningPolicy }> };
  lateFees: { tenant: LateFeePolicy; tenantSaved: boolean; companies: Array<{ locationId: string; updatedAt: string; policy: LateFeePolicy }> };
}

export interface LateFeeRow {
  id: string;
  locationId: string;
  company: string;
  customer: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDueDate: string | null;
  invoiceBalanceCents: number | null;
  periodKey: string;
  asOf: string;
  daysPastDue: number;
  baseCents: number;
  feeCents: number;
  method: string;
  rateBps: number | null;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  financeChargeInvoiceId: string | null;
  financeChargeInvoiceNumber: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface LateFeesResponse {
  rows: LateFeeRow[];
  total: number;
  totalFeeCents: number;
}

export const STATE_LOOK: Record<JobState, { word: string; pip: 'ready' | 'track' | 'risk' | 'overdue' | 'blocked' | 'open' | 'soft' | 'closed' }> = {
  running_normally: { word: 'Running', pip: 'ready' },
  failing: { word: 'Failing', pip: 'overdue' },
  disabled: { word: 'Off', pip: 'closed' },
  not_built: { word: 'Not built yet', pip: 'soft' },
  never_run: { word: 'Waiting for first run', pip: 'open' },
};

export const RUN_LOOK: Record<RunStatus, { word: string; tone: 'default' | 'pos' | 'neg' | 'warn' }> = {
  running: { word: 'Running', tone: 'default' },
  ok: { word: 'Done', tone: 'pos' },
  partial: { word: 'Partly done', tone: 'warn' },
  failed: { word: 'Failed', tone: 'neg' },
  skipped: { word: 'Skipped', tone: 'default' },
};

const DOW = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** "06:10 your time" for a UTC hour:minute (today's offset). */
function localClock(h: number, m: number): string {
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Plain-English schedule for the crons the registry uses (falls back to the raw expression). */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = f;
  const num = (v: string) => /^\d+$/.test(v);
  if (mi.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${mi.slice(2)} minutes`;
  if (num(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Hourly at :${mi.padStart(2, '0')}`;
  if (!num(mi) || !num(h) || mon !== '*') return expr;
  const at = localClock(Number(h), Number(mi));
  if (dom === '*' && dow === '*') return `Daily · ${at}`;
  if (dom === '*' && num(dow)) return `${DOW[Number(dow) % 7]} · ${at}`;
  if (dom === '*' && dow === '1-5') return `Weekdays · ${at}`;
  if (num(dom) && dow === '*') return `Monthly on the ${ordinal(Number(dom))} · ${at}`;
  if (/^\d+-\d+$/.test(dom) && dow === '*') {
    const [a, b] = dom.split('-').map(Number);
    return `Days ${a}–${b} of each month · ${at}`;
  }
  if (/^\d+$/.test(dom) && /^[\d,]+$/.test(mon)) return `Quarterly on the ${ordinal(Number(dom))} · ${at}`;
  return expr;
}

/** "in 3 h" · "2 days ago" · "—". */
export function relative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const d = t - now.getTime();
  const a = Math.abs(d);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const unit = a >= DAY ? `${Math.round(a / DAY)} day${Math.round(a / DAY) === 1 ? '' : 's'}` : a >= HOUR ? `${Math.round(a / HOUR)} h` : a >= MIN ? `${Math.round(a / MIN)} min` : '';
  if (!unit) return 'just now';
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

export function stamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function usd(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Counts worth showing in the run history (skip as_of / ids). */
export function countChips(counts: Record<string, CountValue>): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  for (const [k, v] of Object.entries(counts ?? {})) {
    if (v === null || v === false || v === 0 || k === 'as_of' || k.endsWith('_id') || k.startsWith('gate_')) continue;
    const label = k.replace(/_/g, ' ');
    const val = typeof v === 'number' && k.endsWith('_cents') ? usd(v) : String(v);
    out.push({ k: label.replace(/ cents$/, ''), v: val });
  }
  return out.slice(0, 8);
}
