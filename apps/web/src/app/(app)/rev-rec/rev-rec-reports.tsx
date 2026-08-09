'use client';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, Layers, TrendingUp, PieChart, Info } from 'lucide-react';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

// ---- Response types (mirror lib/services/rev-rec-reporting.ts) ----
interface Period { month: string; start: string; end: string; label: string }
interface RollforwardRow {
  locationId: string; name: string; shortCode: string;
  beginningCents: number; additionsCents: number; recognizedCents: number; endingCents: number;
}
interface Rollforward {
  account: { number: string; name: string } | null;
  hasAccount: boolean;
  total: { beginningCents: number; additionsCents: number; recognizedCents: number; endingCents: number };
  byCompany: RollforwardRow[];
}
interface MethodRow { method: string; methodLabel: string; recognizedCents: number; jobCount: number; pct: number }
interface MethodSummary { totalRecognizedCents: number; rows: MethodRow[] }
interface WaterfallJob {
  jobId: string; jobNumber: string | null; jobName: string | null;
  companyName: string; method: string; methodLabel: string;
  contractCents: number; recognizedToDateCents: number; remainingCents: number;
  pctRecognized: number; byPeriod: Record<string, number>;
}
interface Waterfall { periods: string[]; jobs: WaterfallJob[] }
interface ReportResponse {
  ok: boolean; period: Period;
  rollforward: Rollforward; waterfall: Waterfall; methodSummary: MethodSummary;
}

function defaultMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

const REPORT_TABS = [
  { id: 'rollforward', label: 'Deferred rollforward', icon: Layers },
  { id: 'waterfall', label: 'Recognition waterfall', icon: TrendingUp },
  { id: 'methods', label: 'By method', icon: PieChart },
] as const;
type ReportTab = (typeof REPORT_TABS)[number]['id'];

export function RevRecReports() {
  const [month, setMonth] = useState(defaultMonth());
  const [tab, setTab] = useState<ReportTab>('rollforward');

  const { data, isLoading, error } = useQuery<ReportResponse>(
    '/api/rev-rec/reporting',
    { month },
    { key: `revrec-report-${month}` },
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-2xs uppercase tracking-wider text-slate-500">Reporting period</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || defaultMonth())}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono"
          />
          {data?.period && <span className="text-2xs text-slate-500">{data.period.label}</span>}
        </div>
        <div className="inline-flex rounded-lg bg-slate-800/60 p-0.5">
          {REPORT_TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  tab === t.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="card p-6 text-center"><AlertCircle className="mx-auto text-red-400 mb-2" size={20} /><p className="text-sm text-red-400">{error}</p></div>
      ) : !data ? (
        <div className="card p-10 text-center text-sm text-slate-500">No report data.</div>
      ) : tab === 'rollforward' ? (
        <RollforwardView data={data.rollforward} period={data.period} />
      ) : tab === 'waterfall' ? (
        <WaterfallView data={data.waterfall} />
      ) : (
        <MethodsView data={data.methodSummary} period={data.period} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deferred-revenue rollforward
// ---------------------------------------------------------------------------

function RollforwardView({ data, period }: { data: Rollforward; period: Period }) {
  if (!data.hasAccount) {
    return (
      <div className="card p-10 text-center text-sm text-slate-500">
        <Layers className="mx-auto mb-3 text-slate-600" size={22} />
        No Deferred Revenue account (2410) exists for this company yet. It is created
        the first time revenue is billed in excess of what has been recognized.
      </div>
    );
  }

  const t = data.total;
  const hasActivity = t.beginningCents !== 0 || t.additionsCents !== 0 || t.recognizedCents !== 0 || t.endingCents !== 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Beginning deferred" value={formatMoney(t.beginningCents)} />
        <Stat label="+ New billings" value={formatMoney(t.additionsCents)} tone="brand" />
        <Stat label="− Recognized" value={formatMoney(t.recognizedCents)} tone="down" />
        <Stat label="Ending deferred" value={formatMoney(t.endingCents)} strong />
      </div>

      <p className="flex items-center gap-1.5 text-2xs text-slate-500">
        <Info size={12} /> Ties to GL account {data.account?.number} · {data.account?.name}. Beginning is the balance
        carried into {period.label}; additions are new billings deferred in the period; recognized is deferral
        relieved into revenue.
      </p>

      {!hasActivity ? (
        <div className="card p-10 text-center text-sm text-slate-500">No deferred-revenue activity or balance for this period.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <Th>Company</Th>
                <Th right>Beginning</Th>
                <Th right>+ Billings</Th>
                <Th right>− Recognized</Th>
                <Th right>Ending</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {data.byCompany.map((r) => (
                <tr key={r.locationId} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5">
                    <p className="text-sm text-slate-200 truncate max-w-[260px]">{r.name}</p>
                    {r.shortCode && <span className="text-2xs font-mono text-slate-500">{r.shortCode}</span>}
                  </td>
                  <Money value={r.beginningCents} muted />
                  <Money value={r.additionsCents} tone="brand" />
                  <Money value={r.recognizedCents} tone="down" />
                  <Money value={r.endingCents} strong />
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 bg-slate-800/30">
                <td className="px-4 py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-400">Total</td>
                <Money value={t.beginningCents} strong />
                <Money value={t.additionsCents} strong tone="brand" />
                <Money value={t.recognizedCents} strong tone="down" />
                <Money value={t.endingCents} strong />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recognition waterfall (per-job schedule)
// ---------------------------------------------------------------------------

function WaterfallView({ data }: { data: Waterfall }) {
  const router = useRouter();
  const periods = data.periods;

  const totals = useMemo(() => {
    const t = { contract: 0, recognized: 0, remaining: 0, byPeriod: {} as Record<string, number> };
    for (const j of data.jobs) {
      t.contract += j.contractCents;
      t.recognized += j.recognizedToDateCents;
      t.remaining += j.remainingCents;
      for (const p of periods) t.byPeriod[p] = (t.byPeriod[p] ?? 0) + (j.byPeriod[p] ?? 0);
    }
    return t;
  }, [data.jobs, periods]);

  if (data.jobs.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-slate-500">
        <TrendingUp className="mx-auto mb-3 text-slate-600" size={22} />
        No revenue has been recognized yet. Run recognition to build the schedule.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-2xs text-slate-500">
        <Info size={12} /> Amount recognized per period per contract, with cumulative recognized-to-date vs remaining
        contract value{periods.length >= 12 ? ' (most recent 12 periods shown)' : ''}.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <Th>Job</Th>
              <Th>Method</Th>
              <Th right>Contract</Th>
              {periods.map((p) => <Th key={p} right>{monthLabel(p)}</Th>)}
              <Th right>Recognized</Th>
              <Th right>Remaining</Th>
              <Th right>% Rec</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {data.jobs.map((j) => (
              <tr key={j.jobId} onClick={() => router.push(`/jobs/${j.jobId}`)} className="row-clickable">
                <td className="px-4 py-2">
                  <span className="text-2xs font-mono text-slate-500">{j.jobNumber ?? '--'}</span>
                  <p className="text-sm text-slate-200 truncate max-w-[200px]">{j.jobName ?? j.jobId}</p>
                  {j.companyName && <span className="text-2xs text-slate-600">{j.companyName}</span>}
                </td>
                <td className="px-4 py-2 text-2xs text-slate-400 whitespace-nowrap">{j.methodLabel}</td>
                <Money value={j.contractCents} muted />
                {periods.map((p) => {
                  const v = j.byPeriod[p] ?? 0;
                  return (
                    <td key={p} className={clsx('px-4 py-2 text-right text-xs font-mono', v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-700')}>
                      {v !== 0 ? formatMoney(v) : '—'}
                    </td>
                  );
                })}
                <Money value={j.recognizedToDateCents} />
                <Money value={j.remainingCents} muted />
                <td className="px-4 py-2">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-14 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, j.pctRecognized)) * 100)}%` }} />
                    </div>
                    <span className="text-2xs font-mono text-slate-400 w-9 text-right">{Math.round(j.pctRecognized * 100)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-700 bg-slate-800/30">
              <td className="px-4 py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-400" colSpan={2}>Total</td>
              <Money value={totals.contract} strong muted />
              {periods.map((p) => <Money key={p} value={totals.byPeriod[p] ?? 0} strong tone="brand" />)}
              <Money value={totals.recognized} strong />
              <Money value={totals.remaining} strong muted />
              <td className="px-4 py-2.5" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue recognized this period — by method
// ---------------------------------------------------------------------------

function MethodsView({ data, period }: { data: MethodSummary; period: Period }) {
  if (data.rows.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-slate-500">
        <PieChart className="mx-auto mb-3 text-slate-600" size={22} />
        No revenue was recognized in {period.label}.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Stat label={`Recognized in ${period.label}`} value={formatMoney(data.totalRecognizedCents)} tone="brand" strong />
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <Th>Method</Th>
              <Th right>Jobs</Th>
              <Th right>Recognized</Th>
              <Th>Share</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {data.rows.map((r) => (
              <tr key={r.method} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 text-sm text-slate-200">{r.methodLabel}</td>
                <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-400">{r.jobCount}</td>
                <Money value={r.recognizedCents} />
                <td className="px-4 py-2.5 w-[30%]">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.round(Math.max(0, r.pct) * 100)}%` }} />
                    </div>
                    <span className="text-2xs font-mono text-slate-400 w-9 text-right">{Math.round(r.pct * 100)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared cells
// ---------------------------------------------------------------------------

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={clsx('px-4 py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap', right ? 'text-right' : 'text-left')}>
      {children}
    </th>
  );
}

function Money({ value, tone, strong, muted }: { value: number; tone?: 'brand' | 'down'; strong?: boolean; muted?: boolean }) {
  return (
    <td className={clsx(
      'px-4 py-2.5 text-right font-mono',
      strong ? 'text-sm font-semibold' : 'text-sm',
      tone === 'brand' ? 'text-emerald-400' : tone === 'down' ? 'text-amber-400' : muted ? 'text-slate-500' : 'text-slate-200',
    )}>
      {formatMoney(value)}
    </td>
  );
}

function Stat({ label, value, tone, strong }: { label: string; value: string; tone?: 'brand' | 'down'; strong?: boolean }) {
  return (
    <div className="card p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p className={clsx(
        'font-mono mt-1',
        strong ? 'text-xl font-semibold' : 'text-lg font-semibold',
        tone === 'brand' ? 'text-emerald-400' : tone === 'down' ? 'text-amber-400' : 'text-white',
      )}>{value}</p>
    </div>
  );
}
