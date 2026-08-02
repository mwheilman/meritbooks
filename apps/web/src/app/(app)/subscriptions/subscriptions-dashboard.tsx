'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, RefreshCw, Plus, Sparkles, Pencil, Trash2, CalendarClock,
  TrendingUp, Copy, Clock, Check, XCircle, Ban,
} from 'lucide-react';
import { SubscriptionEditor, type EditorSubscription, type Cadence, type SubStatus } from './subscription-editor';
import { SubscriptionParseReview } from './subscription-parse-review';

type CreepFlag = 'NEW' | 'PRICE_INCREASE' | 'DUPLICATE_CATEGORY' | 'STALE';

interface Subscription {
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

interface RenewalDue {
  subscription: Subscription;
  daysUntilRenewal: number;
  daysUntilNoticeDeadline: number;
  noticeWindowPassed: boolean;
}

interface SubsResponse {
  data: Subscription[];
  renewals: RenewalDue[];
  summary: {
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
  };
}

const CADENCE_ANNUAL: Record<Cadence, number> = { MONTHLY: 12, QUARTERLY: 4, ANNUAL: 1, OTHER: 12 };

const STATUS_STYLE: Record<SubStatus, string> = {
  DETECTED: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  UNDER_REVIEW: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  CANCELLING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CANCELLED: 'bg-slate-700/40 text-slate-400 border-slate-700',
  KEPT: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
};

const FLAG_STYLE: Record<CreepFlag, { label: string; cls: string }> = {
  NEW: { label: 'New', cls: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  PRICE_INCREASE: { label: 'Price ↑', cls: 'bg-red-500/10 text-red-300 border-red-500/20' },
  DUPLICATE_CATEGORY: { label: 'Overlap', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  STALE: { label: 'Stale', cls: 'bg-slate-600/30 text-slate-300 border-slate-600' },
};

const CADENCE_LABEL: Record<Cadence, string> = { MONTHLY: '/mo', QUARTERLY: '/qtr', ANNUAL: '/yr', OTHER: '' };

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtCents(cents: number | null): string {
  return cents === null ? '—' : formatMoney(cents);
}
function annualized(s: Subscription): number {
  return (s.amount_cents ?? 0) * CADENCE_ANNUAL[s.billing_cadence];
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold font-mono', tone ?? 'text-white')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function SubscriptionsDashboard() {
  const [editing, setEditing] = useState<EditorSubscription | 'new' | null>(null);
  const [parsing, setParsing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [refreshKey, setRefreshKey] = useState('0');

  const { data, isLoading, error, refetch } = useQuery<SubsResponse>('/api/subscriptions', undefined, { key: refreshKey });

  const subs = data?.data ?? [];
  const renewals = data?.renewals ?? [];
  const summary = data?.summary;

  function bump() {
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }

  async function scan() {
    setScanning(true);
    const res = await api.post<{ detected: number; created: number; creepCount: number }>('/api/subscriptions/scan', {});
    setScanning(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', `Scan complete — ${res.data?.detected ?? 0} detected, ${res.data?.created ?? 0} new, ${res.data?.creepCount ?? 0} flagged`);
    bump();
  }

  async function decide(s: Subscription, action: 'keep' | 'cancel' | 'review') {
    if (action === 'cancel' && !confirm(`Draft a cancellation request for ${s.vendor_name}? This does NOT cancel it — it prepares a message for you to send.`)) return;
    const res = await api.post<{ cancellationDraft: string | null }>(`/api/subscriptions/${s.id}/decision`, { action });
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    if (action === 'cancel') addToast('success', 'Cancellation drafted — review it below and send it yourself');
    else addToast('success', action === 'keep' ? 'Marked as kept' : 'Marked under review');
    bump();
  }

  async function remove(s: Subscription) {
    if (!confirm(`Remove ${s.vendor_name} from the register? (This does not affect any billing.)`)) return;
    const res = await api.delete(`/api/subscriptions/${s.id}`);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast('success', 'Removed');
    bump();
  }

  function toEditor(s: Subscription): EditorSubscription {
    return {
      id: s.id,
      vendor_name: s.vendor_name,
      product: s.product,
      category: s.category,
      amount_cents: s.amount_cents ?? 0,
      billing_cadence: s.billing_cadence,
      first_seen_date: s.first_seen_date,
      last_charged_date: s.last_charged_date,
      next_renewal_date: s.next_renewal_date,
      status: s.status,
      auto_renews: s.auto_renews,
      notice_period_days: s.notice_period_days,
      cancellation_terms: s.cancellation_terms,
      cancellation_method: s.cancellation_method,
      notes: s.notes,
    };
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={scan} disabled={scanning} className="px-3 py-1.5 text-xs font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Scan for subscriptions
        </button>
        <button onClick={() => setParsing(true)} className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg flex items-center gap-1.5">
          <Sparkles size={13} /> Upload agreement
        </button>
        <button onClick={() => setEditing('new')} className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5">
          <Plus size={13} /> Add subscription
        </button>
        <button onClick={bump} className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800" aria-label="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>

      {/* Creep summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Monthly run-rate" value={formatMoney(summary.totalMonthlyCents)} sub={`${summary.count} subscriptions`} />
          <StatCard label="Annualized spend" value={formatMoney(summary.totalAnnualCents)} tone="text-emerald-400" />
          <StatCard label="Creep signals" value={String(summary.newCount + summary.priceIncreaseCount + summary.duplicateCount + summary.staleCount)} sub={`${summary.newCount} new · ${summary.priceIncreaseCount} price ↑ · ${summary.duplicateCount} overlap · ${summary.staleCount} stale`} tone="text-amber-400" />
          <StatCard label="Renewals due" value={String(summary.renewalsDue)} sub={summary.noticePassed > 0 ? `${summary.noticePassed} past notice deadline` : `next ${summary.windowDays} days`} tone={summary.noticePassed > 0 ? 'text-red-400' : 'text-white'} />
        </div>
      )}

      {/* Renewals needing a decision */}
      {renewals.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-medium text-white">
            <CalendarClock size={15} className="text-amber-400" /> Renewals needing a decision
          </div>
          <div className="space-y-1.5">
            {renewals.slice(0, 8).map((r) => (
              <div key={r.subscription.id} className="flex items-center gap-3 text-sm">
                <span className={clsx('font-mono text-xs w-24 shrink-0', r.noticeWindowPassed ? 'text-red-400' : r.daysUntilNoticeDeadline <= 7 ? 'text-amber-400' : 'text-slate-400')}>
                  {r.noticeWindowPassed ? 'notice passed' : `${r.daysUntilNoticeDeadline}d to decide`}
                </span>
                <span className="text-white flex-1 truncate">{r.subscription.vendor_name}</span>
                <span className="text-slate-400 font-mono">{fmtCents(r.subscription.amount_cents)}{CADENCE_LABEL[r.subscription.billing_cadence]}</span>
                <span className="text-slate-500 text-xs w-24 text-right">renews {fmtDate(r.subscription.next_renewal_date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="card p-12 flex items-center justify-center text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading subscriptions…</div>
      ) : error ? (
        <div className="card p-8 flex items-center gap-3 text-red-400"><AlertCircle size={18} /> Failed to load subscriptions. <button onClick={bump} className="underline">Retry</button></div>
      ) : subs.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-slate-400 mb-1">No subscriptions yet.</div>
          <div className="text-sm text-slate-500 mb-4">Run a scan to detect recurring charges from your bank feed and bills, or add one manually.</div>
          <button onClick={scan} disabled={scanning} className="px-4 py-2 text-sm font-medium bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50">
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Scan for subscriptions
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {subs.map((s) => (
            <div key={s.id} className="card p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-medium truncate">{s.vendor_name}</span>
                    {s.product && <span className="text-slate-500 text-sm truncate">· {s.product}</span>}
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border', STATUS_STYLE[s.status])}>{s.status.replace('_', ' ')}</span>
                    {(s.creep_flags ?? []).map((f) => (
                      <span key={f} className={clsx('text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1', FLAG_STYLE[f].cls)}>
                        {f === 'PRICE_INCREASE' && <TrendingUp size={10} />}
                        {f === 'DUPLICATE_CATEGORY' && <Copy size={10} />}
                        {f === 'STALE' && <Clock size={10} />}
                        {FLAG_STYLE[f].label}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 flex items-center gap-4 text-xs text-slate-500 flex-wrap">
                    <span className="font-mono text-slate-300">{fmtCents(s.amount_cents)}{CADENCE_LABEL[s.billing_cadence]}</span>
                    {s.prior_amount_cents != null && <span className="text-red-400/80 line-through font-mono">{fmtCents(s.prior_amount_cents)}</span>}
                    <span>{formatMoney(annualized(s))}/yr</span>
                    {s.category && <span>· {s.category}</span>}
                    <span>· renews {fmtDate(s.next_renewal_date)}</span>
                    {s.notice_period_days != null && <span>· {s.notice_period_days}d notice</span>}
                    {s.charge_count > 0 && <span>· {s.charge_count} charges</span>}
                  </div>
                  {s.status === 'CANCELLING' && s.cancellation_draft && (
                    <details className="mt-2">
                      <summary className="text-xs text-amber-400 cursor-pointer">Cancellation draft (send this yourself)</summary>
                      <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-400 bg-slate-950 border border-slate-800 rounded-md p-3">{s.cancellation_draft}</pre>
                    </details>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {s.status !== 'KEPT' && (
                    <button onClick={() => decide(s, 'keep')} title="Keep" className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/10"><Check size={15} /></button>
                  )}
                  {s.status !== 'CANCELLING' && s.status !== 'CANCELLED' && (
                    <button onClick={() => decide(s, 'cancel')} title="Draft cancellation" className="p-1.5 rounded text-amber-400 hover:bg-amber-500/10"><Ban size={15} /></button>
                  )}
                  {(s.status === 'DETECTED' || s.status === 'ACTIVE') && (
                    <button onClick={() => decide(s, 'review')} title="Mark under review" className="p-1.5 rounded text-blue-400 hover:bg-blue-500/10"><XCircle size={15} /></button>
                  )}
                  <button onClick={() => setEditing(toEditor(s))} title="Edit" className="p-1.5 rounded text-slate-400 hover:bg-slate-800 hover:text-white"><Pencil size={15} /></button>
                  <button onClick={() => remove(s)} title="Remove" className="p-1.5 rounded text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 size={15} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SubscriptionEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); bump(); }}
        />
      )}
      {parsing && (
        <SubscriptionParseReview onClose={() => setParsing(false)} onSaved={() => { setParsing(false); bump(); }} />
      )}
    </div>
  );
}
