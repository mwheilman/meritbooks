'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  Loader2, AlertCircle, RefreshCw, Plus, Sparkles, Pencil, Trash2,
  TrendingUp, Copy, Clock, Check, XCircle, Ban,
  LayoutGrid, TrendingUp as TrendUp, CalendarClock, KanbanSquare, List,
} from 'lucide-react';
import { SubscriptionEditor, type EditorSubscription } from './subscription-editor';
import { SubscriptionParseReview } from './subscription-parse-review';
import {
  type Subscription, type SubsResponse,
  STATUS_STYLE, FLAG_STYLE, CADENCE_LABEL, fmtDate, fmtCents, annualized,
} from './subscription-types';
import { RunRateSummary, SpendTrend, PriceCreepPanel, RenewalsPanel, TriageBoard } from './subscription-views';

type View = 'overview' | 'creep' | 'renewals' | 'triage' | 'all';

const TABS: { key: View; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'creep', label: 'Price creep', icon: TrendUp },
  { key: 'renewals', label: 'Renewals', icon: CalendarClock },
  { key: 'triage', label: 'Triage', icon: KanbanSquare },
  { key: 'all', label: 'All', icon: List },
];

const TREND_MONTHS = 12;

export function SubscriptionsDashboard() {
  const [editing, setEditing] = useState<EditorSubscription | 'new' | null>(null);
  const [parsing, setParsing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [refreshKey, setRefreshKey] = useState('0');
  const [view, setView] = useState<View>('overview');
  const [windowDays, setWindowDays] = useState(60);
  const [focusId, setFocusId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<SubsResponse>(
    '/api/subscriptions',
    { window_days: String(windowDays), trend_months: String(TREND_MONTHS) },
    { key: refreshKey },
  );

  const subs = data?.data ?? [];
  const renewals = data?.renewals ?? [];
  const trend = data?.trend ?? [];
  const priceCreep = data?.priceCreep ?? [];
  const summary = data?.summary;

  const bump = useCallback(() => {
    setRefreshKey((k) => String(Number(k) + 1));
    refetch();
  }, [refetch]);

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

  const decide = useCallback(
    async (s: Subscription, action: 'keep' | 'cancel' | 'review') => {
      if (action === 'cancel' && !confirm(`Flag ${s.vendor_name} for cancellation and draft a cancellation request? This does NOT cancel it — it prepares a message for you to send.`)) return;
      const res = await api.post<{ cancellationDraft: string | null }>(`/api/subscriptions/${s.id}/decision`, { action });
      if (res.error) {
        addToast('error', res.error.error);
        return;
      }
      if (action === 'cancel') addToast('success', 'Flagged to cancel — review the draft below and send it yourself');
      else addToast('success', action === 'keep' ? 'Marked as kept' : 'Marked under review');
      bump();
    },
    [bump],
  );

  const decideById = useCallback(
    (id: string, action: 'keep' | 'cancel' | 'review') => {
      const s = subs.find((x) => x.id === id);
      if (s) decide(s, action);
    },
    [subs, decide],
  );

  function findInList(id: string) {
    setFocusId(id);
    setView('all');
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

      {/* Run-rate summary (always visible) */}
      {summary && <RunRateSummary summary={summary} />}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-800 overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = view === t.key;
          const badge =
            t.key === 'creep' ? summary?.priceCreepCount :
            t.key === 'renewals' ? summary?.renewalsDue :
            undefined;
          return (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={clsx(
                'px-3 py-2 text-xs font-medium flex items-center gap-1.5 border-b-2 -mb-px whitespace-nowrap',
                active ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200',
              )}
            >
              <Icon size={13} /> {t.label}
              {badge !== undefined && badge > 0 && (
                <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-mono', active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400')}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* States */}
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
        <>
          {view === 'overview' && summary && (
            <div className="space-y-4">
              <SpendTrend trend={trend} summary={summary} />
              <div className="grid gap-4 lg:grid-cols-2">
                <RenewalsPanel renewals={renewals} windowDays={windowDays} onWindowChange={setWindowDays} onDecide={decide} />
                <PriceCreepPanel items={priceCreep.slice(0, 6)} annualizedCreepCents={summary.annualizedCreepCents} onFind={findInList} onDecide={decideById} />
              </div>
            </div>
          )}

          {view === 'creep' && summary && (
            <PriceCreepPanel items={priceCreep} annualizedCreepCents={summary.annualizedCreepCents} onFind={findInList} onDecide={decideById} />
          )}

          {view === 'renewals' && (
            <RenewalsPanel renewals={renewals} windowDays={windowDays} onWindowChange={setWindowDays} onDecide={decide} />
          )}

          {view === 'triage' && <TriageBoard subs={subs} onDecide={decide} onEdit={(s) => setEditing(toEditor(s))} />}

          {view === 'all' && (
            <div className="space-y-2">
              {subs.map((s) => (
                <div
                  key={s.id}
                  ref={focusId === s.id ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined}
                  className={clsx('card p-4', focusId === s.id && 'ring-2 ring-emerald-500/60')}
                >
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
                        <button onClick={() => decide(s, 'cancel')} title="Flag to cancel" className="p-1.5 rounded text-amber-400 hover:bg-amber-500/10"><Ban size={15} /></button>
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
        </>
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
