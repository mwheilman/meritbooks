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
} from 'lucide-react';
import { PageHeader, EmptyState } from '@/components/ui';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney } from '@meritbooks/shared';
import { fmtDate, type RunListItem, type RunsResponse, type RunStatus } from './types';
import { RunStatusBadge } from './run-status';
import { RunWizard } from './run-wizard';
import { RunDetailDrawer } from './run-detail-drawer';

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

  const [wizardOpen, setWizardOpen] = useState(false);
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
        description="Run payroll every pay period: draft the roster, preview the provider-computed gross-to-net, approve under separation of duties, then release the funding. Every run posts a balanced, job-costed entry to the ledger."
        actions={
          canCreate ? (
            <button
              onClick={() => setWizardOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
            >
              <Play size={14} /> Run payroll
            </button>
          ) : undefined
        }
      />

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
                ? 'Start a run to draft the roster, preview the provider-computed gross-to-net, and post a balanced, job-costed entry to the ledger.'
                : 'No payroll runs have been created yet. Runs will appear here once a preparer starts one.'
            }
            action={canCreate ? { label: 'Run payroll', onClick: () => setWizardOpen(true) } : undefined}
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
          onClose={() => setWizardOpen(false)}
          onCreated={() => refetch()}
          onReview={(id) => {
            setWizardOpen(false);
            setDetailId(id);
          }}
        />
      )}

      {detailId && (
        <RunDetailDrawer
          runId={detailId}
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
