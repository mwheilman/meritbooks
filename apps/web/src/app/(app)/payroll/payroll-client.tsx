'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertCircle,
  Wallet,
  Play,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CalendarClock,
  EyeOff,
  UploadCloud,
  FileSpreadsheet,
  Info,
  FlaskConical,
  PlugZap,
} from 'lucide-react';
import { PageHeader, EmptyState } from '@/components/ui';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunListItem, type RunsResponse, type RunStatus } from './types';
import { RunStatusBadge } from './run-status';
import { RunWizard } from './run-wizard';
import { RunDetailDrawer } from './run-detail-drawer';
import { ImportRegister } from './register-import';
import { ImportRegisterCsv } from './register-csv-import';

type SortKey = 'periodEnd' | 'payDate' | 'status' | 'grossCents' | 'netCents' | 'employeeCount';
type SortDir = 'asc' | 'desc';

const TERMINAL: RunStatus[] = ['PAID', 'POSTED', 'RECONCILED', 'REJECTED', 'VOID', 'RETURNED'];
const AWAITING: RunStatus[] = ['PREVIEWED', 'PENDING_APPROVAL'];

export function PayrollClient() {
  const me = useMe();
  const canCreate = me.can('payroll', 'create');
  const grouped = me.user?.payrollVisibility === 'grouped' || me.user?.payrollVisibility === 'none';

  const { data, isLoading, error, refetch } = useQuery<RunsResponse>('/api/payroll/runs');
  const runs = useMemo(() => data?.runs ?? [], [data]);

  // Is a licensed payroll provider (Check/Gusto) actually connected for this
  // tenant? Until one is, running payroll end-to-end inside MeritBooks produces a
  // NON-BINDING ESTIMATE (flat placeholder rates) — not a tax calculation, and no
  // money moves or is filed. We surface that truth everywhere the run path shows.
  const { data: capData } = useQuery<{ capabilities?: Array<{ capability: string; ready: boolean }> }>(
    '/api/integrations/connections',
    undefined,
    { scope: false },
  );
  const providerReady =
    capData?.capabilities?.some((c) => c.capability === 'PAYROLL' && c.ready) ?? false;

  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'payDate', dir: 'desc' });

  const sorted = useMemo(() => {
    const copy = [...runs];
    const { key, dir } = sort;
    const mult = dir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      let av: string | number = a[key];
      let bv: string | number = b[key];
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * mult;
      }
      av = av as number;
      bv = bv as number;
      return (av - bv) * mult;
    });
    return copy;
  }, [runs, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );
  }

  // ── Summary stats ──────────────────────────────────────────────────────────
  const awaitingCount = runs.filter((r) => AWAITING.includes(r.status)).length;
  const inFlightGross = runs
    .filter((r) => !TERMINAL.includes(r.status))
    .reduce((s, r) => s + (r.grossCents ?? 0), 0);
  const nextPayDate = runs
    .filter((r) => !TERMINAL.includes(r.status))
    .map((r) => r.payDate)
    .filter(Boolean)
    .sort()[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll"
        description="Run payroll at your processor, then import the register — we read the period totals and post the balanced, job-costed payroll entry to the ledger. That import is the production path today. Running payroll end to end inside the app requires a connected payroll provider."
        actions={
          canCreate ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                title="Drop the processor's payroll register (PDF or image) and post a balanced payroll entry to the ledger"
              >
                <UploadCloud size={14} /> Import payroll register
              </button>
              <button
                onClick={() => setCsvImportOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                title="Import a CSV or Excel payroll register — no AI. Map the columns, save the mapping, and post a balanced payroll entry."
              >
                <FileSpreadsheet size={14} /> Import from spreadsheet
              </button>
              <button
                onClick={() => setWizardOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                title={
                  providerReady
                    ? 'Run payroll end-to-end through your connected provider'
                    : 'No payroll provider connected — the run wizard produces a non-binding estimate only (not a tax calculation, no filing, no money movement)'
                }
              >
                {providerReady ? <Play size={14} /> : <FlaskConical size={14} className="text-amber-400" />}
                {providerReady ? 'Run payroll' : 'Run payroll (estimate)'}
              </button>
            </div>
          ) : undefined
        }
      />

      {/* Honest framing: which path is real, and what the run wizard is when no
          provider is connected. Always shown so no one mistakes the estimate for
          filed payroll. */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="card flex items-start gap-3 p-4">
          <div className="mt-0.5 rounded-lg bg-emerald-500/10 p-2 text-emerald-400">
            <UploadCloud size={16} />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Import a payroll register</p>
            <p className="mt-0.5 text-xs text-slate-400">
              The production path. Run payroll at ADP, Paychex, Gusto, QuickBooks — or a spreadsheet — then drop the
              register here. We extract the period totals and post a balanced payroll entry you review first.
            </p>
            <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-300">
              <Info size={10} /> Real entries to the ledger
            </span>
          </div>
        </div>
        <div className="card flex items-start gap-3 p-4">
          <div
            className={clsx(
              'mt-0.5 rounded-lg p-2',
              providerReady ? 'bg-indigo-500/10 text-indigo-300' : 'bg-amber-500/10 text-amber-400',
            )}
          >
            {providerReady ? <PlugZap size={16} /> : <FlaskConical size={16} />}
          </div>
          <div>
            <p className="text-sm font-medium text-white">Run payroll in-app</p>
            {providerReady ? (
              <p className="mt-0.5 text-xs text-slate-400">
                A payroll provider is connected. The wizard computes gross-to-net through the provider, holds a
                separation-of-duties approval, and only moves money when you explicitly release.
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-slate-400">
                No payroll provider is connected yet. The wizard runs as a{' '}
                <span className="text-amber-300">non-binding estimate</span> using flat placeholder rates — it does not
                calculate real taxes, withhold, file, or move any money. Use it to preview the workflow only.
              </p>
            )}
            <span
              className={clsx(
                'mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
                providerReady ? 'bg-indigo-500/10 text-indigo-300' : 'bg-amber-500/10 text-amber-300',
              )}
            >
              <Info size={10} /> {providerReady ? 'Provider connected' : 'Provider not connected — estimate only'}
            </span>
          </div>
        </div>
      </div>

      {data && runs.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Next pay date" value={fmtDate(nextPayDate)} icon={<CalendarClock size={14} className="text-indigo-400" />} />
          <Stat label="Awaiting approval" value={String(awaitingCount)} tone={awaitingCount > 0 ? 'warn' : undefined} />
          <Stat
            label="Gross in flight"
            value={grouped ? '••••' : formatMoney(inFlightGross)}
            mono={!grouped}
          />
          <Stat label="Runs" value={String(runs.length)} />
        </div>
      )}

      {grouped && runs.length > 0 && (
        <div className="flex items-center gap-2 text-2xs text-slate-500">
          <EyeOff size={12} /> Your role has grouped payroll visibility — individual pay amounts are hidden; you see run totals and status only.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-6 text-center">
          <AlertCircle className="mx-auto text-red-400 mb-2" size={20} />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : runs.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Wallet}
            title="No payroll runs yet"
            description={
              canCreate
                ? 'Import a payroll register from your processor and we post the balanced, job-costed entry to the ledger. Runs and imports appear here once started.'
                : 'No payroll runs have been created yet. Runs will appear here once a preparer starts one.'
            }
            action={canCreate ? { label: 'Import payroll register', onClick: () => setImportOpen(true) } : undefined}
          />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <SortableTh label="Pay period" active={sort.key === 'periodEnd'} dir={sort.dir} onClick={() => toggleSort('periodEnd')} />
                <SortableTh label="Pay date" active={sort.key === 'payDate'} dir={sort.dir} onClick={() => toggleSort('payDate')} />
                <SortableTh label="Status" active={sort.key === 'status'} dir={sort.dir} onClick={() => toggleSort('status')} />
                <SortableTh label="Employees" align="right" active={sort.key === 'employeeCount'} dir={sort.dir} onClick={() => toggleSort('employeeCount')} />
                <SortableTh label="Gross" align="right" active={sort.key === 'grossCents'} dir={sort.dir} onClick={() => toggleSort('grossCents')} />
                <SortableTh label="Net" align="right" active={sort.key === 'netCents'} dir={sort.dir} onClick={() => toggleSort('netCents')} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {sorted.map((row) => (
                <RunRow key={row.id} row={row} grouped={grouped} onClick={() => setDetailId(row.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wizardOpen && (
        <RunWizard
          providerReady={providerReady}
          onClose={() => setWizardOpen(false)}
          onCreated={() => refetch()}
          onReview={(id) => {
            setWizardOpen(false);
            setDetailId(id);
          }}
        />
      )}

      {importOpen && (
        <ImportRegister
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onPosted={() => refetch()}
        />
      )}

      {csvImportOpen && (
        <ImportRegisterCsv
          open={csvImportOpen}
          onClose={() => setCsvImportOpen(false)}
          onPosted={() => refetch()}
        />
      )}

      {detailId && (
        <RunDetailDrawer
          runId={detailId}
          providerReady={providerReady}
          onClose={() => setDetailId(null)}
          onChanged={() => refetch()}
        />
      )}
    </div>
  );
}

function RunRow({ row, grouped, onClick }: { row: RunListItem; grouped: boolean; onClick: () => void }) {
  return (
    <tr className="hover:bg-slate-800/20 cursor-pointer" onClick={onClick}>
      <td className="px-4 py-2.5 text-sm text-slate-200 whitespace-nowrap">
        {fmtDate(row.periodStart)} <span className="text-slate-600">→</span> {fmtDate(row.periodEnd)}
      </td>
      <td className="px-4 py-2.5 text-sm text-slate-400 whitespace-nowrap">{fmtDate(row.payDate)}</td>
      <td className="px-4 py-2.5">
        <RunStatusBadge status={row.status} />
      </td>
      <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums text-slate-300">{row.employeeCount}</td>
      <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums text-slate-200">
        {grouped ? '••••' : formatMoney(row.grossCents ?? 0)}
      </td>
      <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums text-emerald-400">
        {grouped ? '••••' : formatMoney(row.netCents ?? 0)}
      </td>
    </tr>
  );
}

function SortableTh({
  label,
  align = 'left',
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: 'left' | 'right';
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th className={clsx('px-4 py-2.5', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        onClick={onClick}
        className={clsx(
          'inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider transition-colors',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-slate-300' : 'text-slate-500 hover:text-slate-300',
        )}
      >
        {label}
        {active ? (
          dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
        ) : (
          <ArrowUpDown size={11} className="opacity-50" />
        )}
      </button>
    </th>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
  icon,
}: {
  label: string;
  value: string;
  tone?: 'warn';
  mono?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="card p-3">
      <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-slate-500 font-semibold">
        {icon}
        {label}
      </p>
      <p
        className={clsx(
          'text-lg font-semibold mt-1',
          mono && 'font-mono tabular-nums',
          tone === 'warn' ? 'text-amber-400' : 'text-white',
        )}
      >
        {value}
      </p>
    </div>
  );
}
