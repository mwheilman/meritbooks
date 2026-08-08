'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Loader2, AlertCircle, CalendarClock, Info, ChevronDown, ChevronRight,
  CheckCircle2, ShieldAlert, Clock, ExternalLink, Landmark, X, Undo2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { PageHeader, EmptyState } from '@/components/ui';

// ── Types mirrored from GET /api/tax/sales-tax-calendar ──────────────────────────
type Frequency = 'monthly' | 'quarterly' | 'annual';
type FilingStatus = 'filed' | 'overdue' | 'due-soon' | 'upcoming';

interface CalendarFilingRow {
  periodKey: string;
  label: string;
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: FilingStatus;
  collectedCents: number;
  remittedCents: number;
  netOwedCents: number;
  filedAt: string | null;
  confirmationNumber: string | null;
  filingId: string | null;
}
interface JurisdictionCalendar {
  jurisdiction: string;
  frequency: Frequency;
  frequencySource: 'recorded' | 'default';
  hasConfiguredRate: boolean;
  collectingNow: boolean;
  collectedCents: number;
  remittedCents: number;
  netOwedCents: number;
  openPeriods: number;
  overdueCount: number;
  dueSoonCount: number;
  nextDueDate: string | null;
  rows: CalendarFilingRow[];
}
interface CalendarReport {
  window: { startDate: string; endDate: string; today: string };
  locationFilter: string | null;
  filingsAvailable: boolean;
  jurisdictions: JurisdictionCalendar[];
  totals: {
    collectedCents: number;
    remittedCents: number;
    netOwedCents: number;
    overdueCount: number;
    dueSoonCount: number;
    upcomingCount: number;
    filedCount: number;
    jurisdictionCount: number;
  };
  meta: { invoicesScanned: number; invoicesAttributed: number; generatedAt: string };
}

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const freqLabel: Record<Frequency, string> = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };

function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

interface MarkTarget {
  jurisdiction: string;
  row: CalendarFilingRow;
}

export default function SalesTaxCalendarPage() {
  const { data, isLoading, error, refetch } = useQuery<{ data: CalendarReport }>('/api/tax/sales-tax-calendar');
  const report = data?.data;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [markTarget, setMarkTarget] = useState<MarkTarget | null>(null);

  const totals = report?.totals;
  const jurisdictions = useMemo(() => report?.jurisdictions ?? [], [report]);

  const toggle = (state: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });

  async function unmark(row: CalendarFilingRow) {
    if (!row.filingId) return;
    try {
      const res = await fetch(`/api/tax/filings/${row.filingId}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', `${row.label} reopened`);
        refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        addToast('error', body.error ?? 'Could not reopen filing');
      }
    } catch {
      addToast('error', 'Network error');
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Sales Tax Filing Calendar"
        description="Upcoming and overdue sales/use-tax returns by jurisdiction, with tax collected vs remitted and the net still owed each period. Due dates are computed from each state's filing frequency. Read-only: marking a period filed records the filing — it does not post a remittance or move money."
      />

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
          <button onClick={() => refetch()} className="ml-2 rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700">
            Try again
          </button>
        </div>
      )}

      {!isLoading && !error && report && (
        <div className="space-y-5">
          {/* Filing-record availability notice */}
          {!report.filingsAvailable && (
            <div className="card p-3 flex items-start gap-2 border-blue-500/30 text-blue-300 text-2xs">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>
                Filing records aren&apos;t enabled yet, so every period shows as unfiled and the net owed equals the full collected amount.
                Due dates and amounts are still computed from your accruals. (The <span className="font-mono">sales_tax_filings</span> table is a pending migration.)
              </span>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-4">
            <SummaryCard label="Net owed (window)" valueCents={totals?.netOwedCents ?? 0} emphasize />
            <CountCard label="Overdue" count={totals?.overdueCount ?? 0} tone="danger" icon={ShieldAlert} />
            <CountCard label="Due soon (14d)" count={totals?.dueSoonCount ?? 0} tone="warn" icon={Clock} />
            <SummaryCard label="Tax collected (window)" valueCents={totals?.collectedCents ?? 0} tone="muted" />
          </div>

          <p className="text-2xs text-slate-500">
            {report.window.startDate} → {report.window.endDate} · {totals?.jurisdictionCount ?? 0} jurisdiction
            {(totals?.jurisdictionCount ?? 0) === 1 ? '' : 's'} · {report.meta.invoicesScanned} invoice
            {report.meta.invoicesScanned === 1 ? '' : 's'} scanned · remitted {fmt(totals?.remittedCents ?? 0)}
          </p>

          {jurisdictions.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No filing jurisdictions yet"
              description="No configured sales-tax rates and no collected tax in this window. Add a rate under Settings → Sales-Tax Rates, or create invoices that charge tax, and jurisdictions with filing obligations will appear here."
            />
          ) : (
            <div className="space-y-3">
              {jurisdictions.map((j) => (
                <JurisdictionCard
                  key={j.jurisdiction}
                  j={j}
                  open={expanded.has(j.jurisdiction)}
                  onToggle={() => toggle(j.jurisdiction)}
                  onMark={(row) => setMarkTarget({ jurisdiction: j.jurisdiction, row })}
                  onUnmark={unmark}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {markTarget && (
        <MarkFiledModal
          target={markTarget}
          onClose={() => setMarkTarget(null)}
          onSaved={() => {
            setMarkTarget(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FilingStatus }) {
  const map: Record<FilingStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    filed: { label: 'Filed', cls: 'bg-emerald-500/10 text-emerald-300', Icon: CheckCircle2 },
    overdue: { label: 'Overdue', cls: 'bg-red-500/10 text-red-300', Icon: ShieldAlert },
    'due-soon': { label: 'Due soon', cls: 'bg-amber-500/10 text-amber-300', Icon: Clock },
    upcoming: { label: 'Upcoming', cls: 'bg-slate-700/40 text-slate-300', Icon: CalendarClock },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span className={clsx('badge inline-flex items-center gap-1', cls)}>
      <Icon size={10} /> {label}
    </span>
  );
}

function JurisdictionCard(props: {
  j: JurisdictionCalendar;
  open: boolean;
  onToggle: () => void;
  onMark: (row: CalendarFilingRow) => void;
  onUnmark: (row: CalendarFilingRow) => void;
}) {
  const { j, open, onToggle, onMark, onUnmark } = props;
  const urgent = j.overdueCount > 0;
  return (
    <section className={clsx('card overflow-hidden', urgent && 'border-red-500/30')}>
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-900/30"
      >
        {open ? <ChevronDown size={16} className="text-slate-500 shrink-0" /> : <ChevronRight size={16} className="text-slate-500 shrink-0" />}
        <Landmark size={16} className="text-emerald-400 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{j.jurisdiction}</span>
            <span className="badge badge-neutral text-2xs" title={j.frequencySource === 'recorded' ? 'From your recorded filing cadence' : 'Default cadence (tenant-tunable)'}>
              {freqLabel[j.frequency]}
            </span>
            {!j.hasConfiguredRate && j.collectingNow && (
              <span className="text-2xs text-amber-400/70" title="Tax collected here but no rate configured under Settings.">no rate on file</span>
            )}
          </div>
          <p className="text-2xs text-slate-500 mt-0.5">
            {j.nextDueDate ? <>Next due {fmtDate(j.nextDueDate)}</> : <>All periods filed</>}
            {j.overdueCount > 0 && <span className="text-red-400"> · {j.overdueCount} overdue</span>}
            {j.dueSoonCount > 0 && <span className="text-amber-400"> · {j.dueSoonCount} due soon</span>}
          </p>
        </div>
        <div className="ml-auto text-right shrink-0">
          <p className="text-2xs uppercase tracking-wide text-slate-500">Net owed</p>
          <p className={clsx('font-mono text-base', j.netOwedCents > 0 ? 'text-emerald-300' : 'text-slate-400')}>{fmt(j.netOwedCents)}</p>
        </div>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-slate-800">
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Period</th>
                <th className="text-left font-medium px-4 py-2.5">Due</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5">Collected</th>
                <th className="text-right font-medium px-4 py-2.5">Remitted</th>
                <th className="text-right font-medium px-4 py-2.5">Net owed</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {j.rows.map((row) => (
                <tr key={row.periodKey} className="border-b border-slate-800/40 last:border-0 hover:bg-slate-900/20">
                  <td className="px-4 py-2.5 text-slate-200 font-medium">{row.label}</td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono text-2xs">{fmtDate(row.dueDate)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={row.status} /></td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-200">{fmt(row.collectedCents)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-400">{fmt(row.remittedCents)}</td>
                  <td className={clsx('px-4 py-2.5 text-right font-mono', row.netOwedCents > 0 ? 'text-emerald-300' : 'text-slate-500')}>{fmt(row.netOwedCents)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/sales-tax-return?start_date=${row.periodStart}&end_date=${row.periodEnd}&jurisdiction=${j.jurisdiction}`}
                        className="text-2xs text-slate-400 hover:text-white inline-flex items-center gap-1"
                        title="Open the return worksheet for this period"
                      >
                        Worksheet <ExternalLink size={11} />
                      </Link>
                      {row.status === 'filed' ? (
                        <button onClick={() => onUnmark(row)} className="text-2xs text-slate-400 hover:text-amber-300 inline-flex items-center gap-1" title="Reopen this filing">
                          <Undo2 size={12} /> Reopen
                        </button>
                      ) : (
                        <button onClick={() => onMark(row)} className="btn btn-primary btn-sm">
                          Mark filed
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MarkFiledModal(props: { target: MarkTarget; onClose: () => void; onSaved: () => void }) {
  const { target, onClose, onSaved } = props;
  const { jurisdiction, row } = target;
  const [remitted, setRemitted] = useState(((row.remittedCents || row.collectedCents) / 100).toFixed(2));
  const [confirmation, setConfirmation] = useState(row.confirmationNumber ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const dollars = parseFloat(remitted);
    if (!Number.isFinite(dollars) || dollars < 0) {
      addToast('error', 'Enter a valid remitted amount');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tax/filings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jurisdiction,
          period_key: row.periodKey,
          frequency: row.frequency,
          period_start: row.periodStart,
          period_end: row.periodEnd,
          due_date: row.dueDate,
          status: 'REMITTED',
          remitted_cents: Math.round(dollars * 100),
          collected_cents: row.collectedCents,
          confirmation_number: confirmation.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast('success', `${jurisdiction} ${row.label} marked filed`);
        onSaved();
      } else {
        addToast('error', body.error ?? 'Could not record filing');
        setSaving(false);
      }
    } catch {
      addToast('error', 'Network error');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Mark filed — {jurisdiction} {row.label}</h2>
            <p className="text-2xs text-slate-500 mt-0.5">Due {fmtDate(row.dueDate)} · records the filing only; no GL post.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-2xs">
          <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5">
            <p className="uppercase tracking-wide text-slate-500">Tax collected</p>
            <p className="font-mono text-sm text-slate-200 mt-0.5">{fmt(row.collectedCents)}</p>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5">
            <p className="uppercase tracking-wide text-slate-500">Net owed</p>
            <p className="font-mono text-sm text-emerald-300 mt-0.5">{fmt(row.netOwedCents)}</p>
          </div>
        </div>

        <div>
          <label className="block text-2xs text-slate-400 mb-1">Amount remitted ($)</label>
          <input
            type="number" min={0} step={0.01} value={remitted}
            onChange={(e) => setRemitted(e.target.value)}
            className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white text-right font-mono"
          />
        </div>
        <div>
          <label className="block text-2xs text-slate-400 mb-1">Confirmation number (optional)</label>
          <input
            value={confirmation} onChange={(e) => setConfirmation(e.target.value)}
            placeholder="State portal confirmation"
            className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm text-white"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn btn-ghost btn-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary btn-sm">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Record filing
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard(props: { label: string; valueCents: number; tone?: 'muted'; emphasize?: boolean }) {
  const { label, valueCents, tone, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg', emphasize ? 'text-emerald-300' : tone === 'muted' ? 'text-slate-400' : 'text-white')}>
        {fmt(valueCents)}
      </p>
    </div>
  );
}

function CountCard(props: { label: string; count: number; tone: 'danger' | 'warn'; icon: typeof ShieldAlert }) {
  const { label, count, tone, icon: Icon } = props;
  const active = count > 0;
  return (
    <div className={clsx('card p-3', active && tone === 'danger' && 'border-red-500/40', active && tone === 'warn' && 'border-amber-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500 flex items-center gap-1.5"><Icon size={12} /> {label}</p>
      <p className={clsx('mt-1 font-mono text-lg', !active ? 'text-slate-400' : tone === 'danger' ? 'text-red-300' : 'text-amber-300')}>
        {count}
      </p>
    </div>
  );
}
