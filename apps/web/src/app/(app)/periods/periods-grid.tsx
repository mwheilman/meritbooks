'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ChevronLeft, ChevronRight, Loader2, AlertCircle, CalendarPlus, Lock, Unlock, Check, Calendar,
} from 'lucide-react';
import { clsx } from 'clsx';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';

type CellStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NONE';

interface MonthCell { month: number; status: CellStatus; periodId: string | null; closedAt: string | null }
interface GridRow { locationId: string; locationName: string; shortCode: string; months: MonthCell[]; generated: number }
interface PeriodsResponse {
  year: number;
  grid: GridRow[];
  summary: { companies: number; gaps: number; complete: number };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CELL_STYLE: Record<CellStatus, string> = {
  OPEN: 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border-emerald-500/30',
  SOFT_CLOSE: 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border-amber-500/30',
  HARD_CLOSE: 'bg-slate-700/40 text-slate-400 hover:bg-slate-700/60 border-slate-600/40',
  NONE: 'bg-transparent text-slate-600 hover:bg-slate-800/40 border-dashed border-slate-700/50',
};

export function PeriodsGrid() {
  const nowYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(nowYear);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ row: GridRow; cell: MonthCell; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error, refetch } = useQuery<PeriodsResponse>('/api/periods', { year: String(year) });

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const generate = useCallback(async (locationId: string) => {
    setBusy(true);
    setMenu(null);
    try {
      const res = await fetch('/api/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, location_id: locationId }),
      });
      const result = await res.json();
      if (!res.ok) { addToast('error', result.error ?? 'Failed to generate'); return; }
      addToast('success', `${result.periods_created} period(s) generated`);
      refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setBusy(false);
    }
  }, [year, refetch]);

  const setStatus = useCallback(async (periodId: string, status: CellStatus, reason?: string) => {
    setMenu(null);
    const res = await fetch('/api/periods', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_id: periodId, status, reason: reason ?? null }),
    });
    const result = await res.json();
    if (!res.ok) { addToast('error', result.error ?? 'Failed'); return; }
    addToast('success', `Period set to ${status.replace('_', ' ').toLowerCase()}`);
    refetch();
  }, [refetch]);

  const onCellClick = useCallback((row: GridRow, cell: MonthCell, e: React.MouseEvent) => {
    if (cell.status === 'NONE') { generate(row.locationId); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ row, cell, x: rect.left, y: rect.bottom + 4 });
  }, [generate]);

  const summary = data?.summary;
  const hasGaps = (summary?.gaps ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* Year nav + generate-all */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => setYear((y) => y - 1)} aria-label="Previous year" className="p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-white"><ChevronLeft size={16} /></button>
          <span className="text-lg font-semibold text-white font-mono w-16 text-center">{year}</span>
          <button onClick={() => setYear((y) => y + 1)} aria-label="Next year" className="p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-white"><ChevronRight size={16} /></button>
          {year !== nowYear && (
            <button onClick={() => setYear(nowYear)} className="text-xs text-slate-500 hover:text-slate-300 ml-1">Today</button>
          )}
        </div>
        <button
          onClick={() => generate('all')}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <CalendarPlus size={14} />} Generate {year} for all companies
        </button>
      </div>

      {/* Gap banner */}
      {hasGaps && !isLoading && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertCircle size={15} className="text-amber-400 shrink-0" />
          <p className="text-xs text-amber-300">
            {summary?.gaps} month-slot(s) have no period in {year}. Entries dated in those months can&apos;t post until the period exists — generate above, or click an empty cell.
          </p>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-2xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/30 border border-emerald-500/40" /> Open</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-500/30 border border-amber-500/40" /> Soft close</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-600/50 border border-slate-600" /> Hard close (locked)</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-dashed border-slate-600" /> Not generated</span>
      </div>

      {isLoading ? (
        <TableSkeleton rows={5} cols={13} />
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : !data || data.grid.length === 0 ? (
        <EmptyState icon={Calendar} title="No companies" description="Add a company to manage its fiscal periods." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 sticky left-0 bg-surface-900">Company</th>
                {MONTHS.map((m) => (
                  <th key={m} className="px-2 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">{m}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {data.grid.map((row) => (
                <tr key={row.locationId} className="hover:bg-slate-800/10">
                  <td className="px-4 py-2 sticky left-0 bg-surface-900">
                    <div className="flex items-center gap-2">
                      <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">{row.shortCode}</span>
                      <span className="text-sm text-slate-200 truncate max-w-[160px]">{row.locationName}</span>
                    </div>
                  </td>
                  {row.months.map((cell) => (
                    <td key={cell.month} className="px-1 py-1.5 text-center">
                      <button
                        onClick={(e) => onCellClick(row, cell, e)}
                        disabled={busy}
                        title={cell.status === 'NONE' ? 'Click to generate this year' : cell.status.replace('_', ' ')}
                        aria-label={`${row.locationName} ${MONTHS[cell.month - 1]} ${year} — ${cell.status === 'NONE' ? 'not generated' : cell.status.replace('_', ' ').toLowerCase()}`}
                        className={clsx('w-full h-7 rounded border text-2xs font-medium transition-colors flex items-center justify-center', CELL_STYLE[cell.status])}
                      >
                        {cell.status === 'HARD_CLOSE' ? <Lock size={11} /> : cell.status === 'NONE' ? '+' : cell.status === 'SOFT_CLOSE' ? 'S' : 'O'}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Status menu */}
      {menu && menu.cell.periodId && (
        <div
          ref={menuRef}
          style={{ left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth - 220 : menu.x)), top: menu.y }}
          className="fixed z-50 w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-800 text-2xs text-slate-500">
            {menu.row.shortCode} · {MONTHS[menu.cell.month - 1]} {year}
          </div>
          {menu.cell.status !== 'OPEN' && (
            <MenuItem icon={Unlock} label={menu.cell.status === 'HARD_CLOSE' ? 'Reopen (Open)' : 'Set Open'}
              onClick={() => {
                if (menu.cell.status === 'HARD_CLOSE') {
                  const reason = window.prompt('Reason for reopening this hard-closed period?');
                  if (!reason) return;
                  setStatus(menu.cell.periodId!, 'OPEN', reason);
                } else setStatus(menu.cell.periodId!, 'OPEN');
              }} />
          )}
          {menu.cell.status !== 'SOFT_CLOSE' && menu.cell.status !== 'HARD_CLOSE' && (
            <MenuItem icon={Check} label="Soft close" onClick={() => setStatus(menu.cell.periodId!, 'SOFT_CLOSE')} />
          )}
          {menu.cell.status !== 'HARD_CLOSE' && (
            <MenuItem icon={Lock} label="Hard close (lock)" danger onClick={() => setStatus(menu.cell.periodId!, 'HARD_CLOSE')} />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Lock; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={clsx('w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-800', danger ? 'text-red-400' : 'text-slate-300')}>
      <Icon size={14} /> {label}
    </button>
  );
}
