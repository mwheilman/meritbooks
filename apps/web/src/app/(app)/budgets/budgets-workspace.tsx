'use client';

import { useMemo, useState, type ElementType } from 'react';
import { clsx } from 'clsx';
import { Building2, Calendar, LayoutGrid, GitCompare, Layers } from 'lucide-react';
import { useQuery } from '@/hooks';
import { BudgetEntryGrid } from './budget-entry-grid';
import { BudgetVsActual } from './budget-vs-actual';

// ── Shared shapes (fields verified against migration 013 + /api routes) ──
export interface LocationLite { id: string; name: string; short_code: string; industry: string | null }
export interface DepartmentLite { id: string; name: string; location_id: string | null }

const CURRENT_YEAR = new Date().getFullYear();
const FISCAL_YEARS = [CURRENT_YEAR + 1, CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

type Tab = 'entry' | 'variance';

export function BudgetsWorkspace() {
  const [tab, setTab] = useState<Tab>('entry');
  const [fiscalYear, setFiscalYear] = useState(CURRENT_YEAR);
  const [locationId, setLocationId] = useState<string>(''); // '' = All companies
  const [departmentId, setDepartmentId] = useState<string>(''); // '' = company-level (no dept)

  const { data: rawLocs } = useQuery<LocationLite[]>('/api/locations');
  const locations = useMemo(() => rawLocs ?? [], [rawLocs]);

  const { data: deptData } = useQuery<{ departments: DepartmentLite[] }>('/api/departments');
  const departments = useMemo(() => {
    const all = deptData?.departments ?? [];
    if (!locationId) return [];
    return all.filter((d) => d.location_id === locationId);
  }, [deptData, locationId]);

  return (
    <div>
      {/* ─── Tabs ─── */}
      <div className="flex items-center gap-1 mb-5">
        <TabButton active={tab === 'entry'} icon={LayoutGrid} label="Budget Entry" onClick={() => setTab('entry')} />
        <TabButton active={tab === 'variance'} icon={GitCompare} label="Budget vs Actual" onClick={() => setTab('variance')} />
      </div>

      {/* ─── Shared scope controls ─── */}
      <div className="flex items-center gap-2 mb-5 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Building2 size={13} className="text-slate-500" />
          <select
            value={locationId}
            onChange={(e) => { setLocationId(e.target.value); setDepartmentId(''); }}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white max-w-[240px]"
          >
            <option value="">All Companies{tab === 'variance' ? ' (Consolidated)' : ''}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <Calendar size={13} className="text-slate-500" />
          <select
            value={fiscalYear}
            onChange={(e) => setFiscalYear(parseInt(e.target.value, 10))}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono"
          >
            {FISCAL_YEARS.map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
        </div>

        {locationId && departments.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Layers size={13} className="text-slate-500" />
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white max-w-[220px]"
            >
              <option value="">Company-level (no dept)</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {tab === 'entry' ? (
        <BudgetEntryGrid
          locationId={locationId}
          locationName={locations.find((l) => l.id === locationId)?.name ?? ''}
          fiscalYear={fiscalYear}
          departmentId={departmentId || null}
        />
      ) : (
        <BudgetVsActual
          locationId={locationId}
          fiscalYear={fiscalYear}
          departmentId={departmentId || null}
        />
      )}
    </div>
  );
}

function TabButton({ active, icon: Icon, label, onClick }: {
  active: boolean; icon: ElementType; label: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors',
        active ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
      )}
    >
      <Icon size={15} />{label}
    </button>
  );
}
