'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { InvoiceDrawer } from '../invoice-drawer';
import {
  ArrowLeft, AlertCircle, Loader2, Send, Bell, ChevronDown, ChevronRight,
  Building2, TrendingUp, Clock, Wallet, Percent, CalendarClock, Users, Mail, Eye,
} from 'lucide-react';

// ─── Types (mirror the /api/invoices/collections payload) ─────────────────

type Bucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
type BucketMap = Record<Bucket, { count: number; balanceCents: number }>;

interface WorklistItem {
  id: string; invoiceNumber: string; customerId: string | null; customerName: string;
  customerEmail: string | null; invoiceDate: string; dueDate: string;
  totalCents: number; balanceCents: number; daysOverdue: number; bucket: Bucket;
  status: string; locationName: string | null; locationCode: string | null;
  lastSentAt: string | null; sentCount: number;
  lastViewedAt: string | null; viewCount: number;
  lastReminderAt: string | null; reminderCount: number;
  priorityScore: number;
}

interface CustomerRollup {
  customerId: string | null; customerName: string; customerEmail: string | null;
  openBalanceCents: number; overdueBalanceCents: number; invoiceCount: number;
  overdueCount: number; oldestDaysOverdue: number; avgDaysToPay: number | null;
  lastContactAt: string | null; buckets: BucketMap; invoices: WorklistItem[];
}

interface CollectionsPayload {
  asOf: string; agingMethod: 'DUE_DATE' | 'INVOICE_DATE'; dsoDays: number;
  kpis: {
    totalArCents: number; overdueArCents: number; currentArCents: number;
    pctCurrent: number | null; dso: number | null; avgDaysToPay: number | null;
    creditSalesCents: number; openInvoiceCount: number; overdueInvoiceCount: number;
    customerCount: number;
  };
  buckets: BucketMap;
  worklist: WorklistItem[];
  customers: CustomerRollup[];
}

interface LocationOption { id: string; name: string; short_code: string }

const BUCKET_ORDER: Bucket[] = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
const BUCKET_LABEL: Record<Bucket, string> = {
  CURRENT: 'Current', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': '90+ days',
};
const BUCKET_COLOR: Record<Bucket, string> = {
  CURRENT: 'bg-emerald-500', '1-30': 'bg-amber-400', '31-60': 'bg-orange-500',
  '61-90': 'bg-red-500', '90+': 'bg-red-700',
};
const BUCKET_TEXT: Record<Bucket, string> = {
  CURRENT: 'text-emerald-400', '1-30': 'text-amber-300', '31-60': 'text-orange-300',
  '61-90': 'text-red-300', '90+': 'text-red-400',
};

// ─── Small formatters ─────────────────────────────────────────────────────

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
const fmtWhenLong = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

// ─── Sorting for the worklist ──────────────────────────────────────────────

type SortKey = 'priority' | 'balance' | 'daysOverdue' | 'customer' | 'due';
function sortWorklist(rows: WorklistItem[], key: SortKey, dir: 1 | -1): WorklistItem[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    let d = 0;
    switch (key) {
      case 'priority': d = a.priorityScore - b.priorityScore; break;
      case 'balance': d = a.balanceCents - b.balanceCents; break;
      case 'daysOverdue': d = a.daysOverdue - b.daysOverdue; break;
      case 'customer': d = a.customerName.localeCompare(b.customerName); break;
      case 'due': d = a.dueDate.localeCompare(b.dueDate); break;
    }
    return d * dir;
  });
  return copy;
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function CollectionsDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const [locationId, setLocationId] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [agingMethod, setAgingMethod] = useState<'DUE_DATE' | 'INVOICE_DATE'>('DUE_DATE');
  const [dsoDays, setDsoDays] = useState('90');
  const [tab, setTab] = useState<'worklist' | 'customers'>('worklist');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const params = new URLSearchParams();
  if (locationId) params.set('location_id', locationId);
  if (asOf) params.set('as_of', asOf);
  params.set('aging_method', agingMethod);
  params.set('dso_days', dsoDays);

  const { data, isLoading, error, refetch } = useQuery<CollectionsPayload>(
    `/api/invoices/collections?${params.toString()}`,
    undefined,
    { key: String(reloadKey) },
  );
  const { data: locData } = useQuery<{ data: LocationOption[] }>('/api/locations');
  const locations = locData?.data ?? [];

  async function sendReminder(inv: WorklistItem) {
    if (!inv.customerEmail) {
      addToast('error', `${inv.customerName} has no email address on file.`);
      return;
    }
    setRemindingId(inv.id);
    try {
      const res = await fetch(`/api/invoices/${inv.id}/remind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'MANUAL' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        addToast('success', `Reminder sent to ${body.to}`);
        setReloadKey((k) => k + 1);
        refetch();
      } else {
        addToast('error', body.error ?? 'Could not send the reminder.');
      }
    } catch {
      addToast('error', 'Could not reach the send service. Try again.');
    } finally {
      setRemindingId(null);
    }
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Invoices &amp; AR
          </Link>
          <h1 className="text-2xl font-semibold text-white">Collections &amp; DSO</h1>
          <p className="text-sm text-slate-400 mt-1">Aging, days sales outstanding, and the overdue worklist</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative">
          <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
            className="pl-9 pr-8 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white appearance-none cursor-pointer">
            <option value="">All companies</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-400">
          As of
          <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)}
            className="px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white" />
        </label>

        <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden text-xs">
          {(['DUE_DATE', 'INVOICE_DATE'] as const).map((m) => (
            <button key={m} onClick={() => setAgingMethod(m)}
              className={`px-3 py-2 ${agingMethod === m ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
              {m === 'DUE_DATE' ? 'Age by due date' : 'Age by invoice date'}
            </button>
          ))}
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-400">
          DSO window
          <select value={dsoDays} onChange={(e) => setDsoDays(e.target.value)}
            className="px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white">
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">365 days</option>
          </select>
        </label>
      </div>

      {/* Error */}
      {error && (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-red-400">Failed to load collections</p>
          <p className="text-sm text-slate-500 mt-1">{error}</p>
        </div>
      )}

      {/* Loading */}
      {isLoading && !data && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <KpiCard icon={Wallet} color="text-blue-400" label="Total AR"
              value={formatMoney(data.kpis.totalArCents)} sub={`${data.kpis.customerCount} customers`} />
            <KpiCard icon={Clock} color="text-red-400" label="Overdue AR"
              value={formatMoney(data.kpis.overdueArCents)} sub={`${data.kpis.overdueInvoiceCount} invoices`} />
            <KpiCard icon={TrendingUp} color="text-indigo-400" label="DSO"
              value={data.kpis.dso != null ? `${data.kpis.dso}d` : '—'}
              sub={data.kpis.dso != null ? `over ${data.dsoDays}d sales` : 'no credit sales'} />
            <KpiCard icon={CalendarClock} color="text-amber-300" label="Avg days to pay"
              value={data.kpis.avgDaysToPay != null ? `${data.kpis.avgDaysToPay}d` : '—'}
              sub={data.kpis.avgDaysToPay != null ? `trailing ${data.dsoDays}d` : 'no paid invoices'} />
            <KpiCard icon={Percent} color="text-emerald-400" label="% Current"
              value={data.kpis.pctCurrent != null ? `${data.kpis.pctCurrent}%` : '—'}
              sub={formatMoney(data.kpis.currentArCents)} />
          </div>

          {/* Aging buckets */}
          <AgingBar buckets={data.buckets} total={data.kpis.totalArCents} />

          {/* Tabs */}
          <div className="flex gap-1 mt-6 mb-4 border-b border-slate-700/50">
            <TabButton active={tab === 'worklist'} onClick={() => setTab('worklist')}
              label={`Worklist (${data.worklist.length})`} icon={Clock} />
            <TabButton active={tab === 'customers'} onClick={() => setTab('customers')}
              label={`By customer (${data.customers.length})`} icon={Users} />
          </div>

          {tab === 'worklist' ? (
            <Worklist rows={data.worklist} onOpen={setDrawerId} onRemind={sendReminder} remindingId={remindingId} />
          ) : (
            <CustomerTable customers={data.customers} onOpen={setDrawerId} onRemind={sendReminder} remindingId={remindingId} />
          )}
        </>
      )}

      <InvoiceDrawer invoiceId={drawerId} onClose={() => { setDrawerId(null); setReloadKey((k) => k + 1); refetch(); }} />
    </div>
  );
}

// ─── KPI card ──────────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, color, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; color: string; label: string; value: string; sub: string;
}) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className="text-xl font-mono font-semibold text-white tabular-nums">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{sub}</p>
    </div>
  );
}

// ─── Aging bar ─────────────────────────────────────────────────────────────

function AgingBar({ buckets, total }: { buckets: BucketMap; total: number }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">AR aging</h2>
        <span className="text-xs text-slate-500 font-mono">{formatMoney(total)} outstanding</span>
      </div>
      {total > 0 ? (
        <div className="flex h-2.5 rounded-full overflow-hidden mb-4">
          {BUCKET_ORDER.map((b) => {
            const pct = (buckets[b].balanceCents / total) * 100;
            return pct > 0 ? <div key={b} className={BUCKET_COLOR[b]} style={{ width: `${pct}%` }} title={`${BUCKET_LABEL[b]}: ${formatMoney(buckets[b].balanceCents)}`} /> : null;
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mb-4">No open receivables in this scope.</p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {BUCKET_ORDER.map((b) => (
          <div key={b} className="rounded-lg bg-slate-900/50 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${BUCKET_COLOR[b]}`} />
              <span className="text-xs text-slate-400">{BUCKET_LABEL[b]}</span>
            </div>
            <p className={`text-base font-mono font-semibold mt-1 tabular-nums ${BUCKET_TEXT[b]}`}>{formatMoney(buckets[b].balanceCents)}</p>
            <p className="text-[11px] text-slate-500">{buckets[b].count} inv</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, icon: Icon }: {
  active: boolean; onClick: () => void; label: string; icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-lg transition-colors ${
        active ? 'bg-slate-800 text-emerald-400 border-b-2 border-emerald-400' : 'text-slate-400 hover:text-white'
      }`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// ─── Last-activity cell ────────────────────────────────────────────────────

function LastActivity({ inv }: { inv: WorklistItem }) {
  const bits: React.ReactNode[] = [];
  if (inv.lastReminderAt) bits.push(<span key="r" className="inline-flex items-center gap-1 text-amber-300"><Bell className="w-3 h-3" />{fmtWhen(inv.lastReminderAt)}{inv.reminderCount > 1 ? ` ×${inv.reminderCount}` : ''}</span>);
  else if (inv.lastSentAt) bits.push(<span key="s" className="inline-flex items-center gap-1 text-slate-400"><Mail className="w-3 h-3" />{fmtWhen(inv.lastSentAt)}{inv.sentCount > 1 ? ` ×${inv.sentCount}` : ''}</span>);
  if (inv.viewCount > 0) bits.push(<span key="v" className="inline-flex items-center gap-1 text-slate-500"><Eye className="w-3 h-3" />{fmtWhen(inv.lastViewedAt)}{inv.viewCount > 1 ? ` ×${inv.viewCount}` : ''}</span>);
  if (bits.length === 0) return <span className="text-slate-600 text-xs">Never contacted</span>;
  return <span className="inline-flex items-center gap-2 text-xs">{bits}</span>;
}

function RemindButton({ inv, onRemind, busy }: {
  inv: WorklistItem; onRemind: (inv: WorklistItem) => void; busy: boolean;
}) {
  const disabled = busy || !inv.customerEmail;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onRemind(inv); }}
      disabled={disabled}
      title={inv.customerEmail ? `Email a payment reminder to ${inv.customerEmail}` : 'No customer email on file'}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
      {busy ? 'Sending…' : inv.lastReminderAt ? 'Remind again' : 'Send reminder'}
    </button>
  );
}

// ─── Worklist table ────────────────────────────────────────────────────────

function Worklist({ rows, onOpen, onRemind, remindingId }: {
  rows: WorklistItem[]; onOpen: (id: string) => void;
  onRemind: (inv: WorklistItem) => void; remindingId: string | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [dir, setDir] = useState<1 | -1>(-1);
  const sorted = useMemo(() => sortWorklist(rows, sortKey, dir), [rows, sortKey, dir]);

  const toggle = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(-1); }
  };
  const Arrow = ({ k }: { k: SortKey }) => sortKey === k ? <span className="text-emerald-400">{dir === 1 ? '↑' : '↓'}</span> : null;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16">
        <Clock className="w-10 h-10 text-slate-600 mx-auto mb-3" />
        <p className="text-slate-400 font-medium">Nothing overdue</p>
        <p className="text-sm text-slate-500 mt-1">Every open invoice in this scope is within terms.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
            <th className="pb-3 pr-4">#</th>
            <th className="pb-3 pr-4 cursor-pointer select-none" onClick={() => toggle('customer')}>Customer <Arrow k="customer" /></th>
            <th className="pb-3 pr-4">Invoice</th>
            <th className="pb-3 pr-4 cursor-pointer select-none" onClick={() => toggle('due')}>Due <Arrow k="due" /></th>
            <th className="pb-3 pr-4 text-right cursor-pointer select-none" onClick={() => toggle('daysOverdue')}>Days late <Arrow k="daysOverdue" /></th>
            <th className="pb-3 pr-4 text-right cursor-pointer select-none" onClick={() => toggle('balance')}>Balance <Arrow k="balance" /></th>
            <th className="pb-3 pr-4 cursor-pointer select-none" onClick={() => toggle('priority')}>Last activity <Arrow k="priority" /></th>
            <th className="pb-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((inv, i) => (
            <tr key={inv.id} onClick={() => onOpen(inv.id)}
              className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer">
              <td className="py-3 pr-4 text-slate-500 font-mono text-xs">{i + 1}</td>
              <td className="py-3 pr-4">
                <div className="text-slate-200">{inv.customerName}</div>
                {inv.locationCode && <div className="text-[11px] text-slate-500">{inv.locationCode}</div>}
              </td>
              <td className="py-3 pr-4">
                <span className="font-mono text-slate-300 text-xs">{inv.invoiceNumber}</span>
              </td>
              <td className="py-3 pr-4 font-mono text-xs text-slate-400">{inv.dueDate}</td>
              <td className="py-3 pr-4 text-right">
                <span className={`font-mono text-xs px-1.5 py-0.5 rounded ${BUCKET_TEXT[inv.bucket]} ${inv.bucket === '90+' ? 'bg-red-500/10' : ''}`}>{inv.daysOverdue}d</span>
              </td>
              <td className="py-3 pr-4 text-right font-mono text-white font-medium tabular-nums">{formatMoney(inv.balanceCents)}</td>
              <td className="py-3 pr-4"><LastActivity inv={inv} /></td>
              <td className="py-3 text-right"><RemindButton inv={inv} onRemind={onRemind} busy={remindingId === inv.id} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Customer rollup (expandable) ──────────────────────────────────────────

function CustomerTable({ customers, onOpen, onRemind, remindingId }: {
  customers: CustomerRollup[]; onOpen: (id: string) => void;
  onRemind: (inv: WorklistItem) => void; remindingId: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (customers.length === 0) {
    return (
      <div className="text-center py-16">
        <Users className="w-10 h-10 text-slate-600 mx-auto mb-3" />
        <p className="text-slate-400 font-medium">No open receivables</p>
        <p className="text-sm text-slate-500 mt-1">There are no customers with an outstanding balance in this scope.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
            <th className="pb-3 pr-4">Customer</th>
            <th className="pb-3 pr-4 text-right">Open</th>
            <th className="pb-3 pr-4 text-right">Overdue</th>
            <th className="pb-3 pr-4 text-right">Oldest</th>
            <th className="pb-3 pr-4 text-right">Avg pay</th>
            <th className="pb-3 pr-4">Last contact</th>
            <th className="pb-3 text-right">Invoices</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => {
            const key = c.customerId ?? 'UNASSIGNED';
            const open = expanded === key;
            return (
              <React.Fragment key={key}>
                <tr onClick={() => setExpanded(open ? null : key)}
                  className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer">
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center gap-1.5 text-slate-200">
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                      {c.customerName}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-white tabular-nums">{formatMoney(c.openBalanceCents)}</td>
                  <td className="py-3 pr-4 text-right font-mono tabular-nums text-red-300">{c.overdueBalanceCents > 0 ? formatMoney(c.overdueBalanceCents) : '—'}</td>
                  <td className="py-3 pr-4 text-right font-mono text-xs text-slate-400">{c.oldestDaysOverdue > 0 ? `${c.oldestDaysOverdue}d` : '—'}</td>
                  <td className="py-3 pr-4 text-right font-mono text-xs text-slate-400">{c.avgDaysToPay != null ? `${c.avgDaysToPay}d` : '—'}</td>
                  <td className="py-3 pr-4 text-xs text-slate-500">{fmtWhenLong(c.lastContactAt) ?? 'Never'}</td>
                  <td className="py-3 text-right text-xs text-slate-400">{c.overdueCount}/{c.invoiceCount} overdue</td>
                </tr>
                {open && c.invoices.map((inv) => (
                  <tr key={inv.id} onClick={() => onOpen(inv.id)}
                    className="border-b border-slate-800/40 bg-slate-900/40 hover:bg-slate-800/40 cursor-pointer">
                    <td className="py-2 pr-4 pl-8">
                      <span className="font-mono text-xs text-slate-300">{inv.invoiceNumber}</span>
                      {inv.locationCode && <span className="ml-2 text-[11px] text-slate-500">{inv.locationCode}</span>}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-slate-200 tabular-nums">{formatMoney(inv.balanceCents)}</td>
                    <td className="py-2 pr-4 text-right">
                      {inv.daysOverdue > 0
                        ? <span className={`font-mono text-xs ${BUCKET_TEXT[inv.bucket]}`}>{inv.daysOverdue}d late</span>
                        : <span className="font-mono text-xs text-emerald-400">current</span>}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs text-slate-500">{inv.dueDate}</td>
                    <td className="py-2 pr-4" />
                    <td className="py-2 pr-4"><LastActivity inv={inv} /></td>
                    <td className="py-2 text-right">
                      {inv.daysOverdue > 0 && <RemindButton inv={inv} onRemind={onRemind} busy={remindingId === inv.id} />}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
