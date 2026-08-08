'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle, Plus, Check, Building2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

interface Entity {
  id: string;
  name: string;
  shortCode: string;
  industry: string | null;
  fiscalYearStartMonth: number;
  revRecMethod: string;
  isActive: boolean;
}

interface EntitiesResponse {
  baseCurrency: string;
  orgFiscalYearStartMonth: number;
  entities: Entity[];
}

const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i).toLocaleString('en', { month: 'short' }),
}));

const REV_REC_LABELS: Record<string, string> = {
  POINT_OF_SALE: 'Point of Sale',
  AS_BILLED: 'As Billed',
  PCT_COMPLETE: '% Complete',
  PCT_COSTS_INCURRED: '% Costs Incurred',
  COMPLETED_CONTRACT: 'Completed Contract',
  MILESTONE: 'Milestone',
  RATABLY: 'Ratably',
  SUBSCRIPTION: 'Subscription',
  CASH: 'Cash Basis',
};

export function CompaniesPanel() {
  const { data, isLoading, error, refetch } = useQuery<EntitiesResponse>('/api/settings/entities');
  const [drafts, setDrafts] = useState<Record<string, { fiscalYearStartMonth: number; revRecMethod: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const entities = data?.entities ?? [];

  useEffect(() => {
    if (!entities.length) return;
    setDrafts((prev) => {
      const missing = entities.filter((e) => !prev[e.id]);
      if (missing.length === 0) return prev; // no change → avoid a re-render loop
      const next = { ...prev };
      for (const e of missing) next[e.id] = { fiscalYearStartMonth: e.fiscalYearStartMonth, revRecMethod: e.revRecMethod };
      return next;
    });
  }, [entities]);

  const isDirty = useCallback((e: Entity) => {
    const d = drafts[e.id];
    return d && (d.fiscalYearStartMonth !== e.fiscalYearStartMonth || d.revRecMethod !== e.revRecMethod);
  }, [drafts]);

  const save = useCallback(async (e: Entity) => {
    const d = drafts[e.id];
    if (!d) return;
    setSavingId(e.id);
    const res = await fetch(`/api/settings/entities/${e.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiscal_year_start_month: d.fiscalYearStartMonth, rev_rec_method: d.revRecMethod }),
    });
    setSavingId(null);
    if (res.ok) {
      addToast('success', `${e.name} updated`);
      refetch();
    } else {
      addToast('error', (await res.json().catch(() => ({}))).error ?? 'Failed to save');
    }
  }, [drafts, refetch]);

  const selectCls = 'px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-emerald-500/50';

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-6 text-center"><AlertCircle className="w-6 h-6 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>;

  return (
    <div className="card p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Companies</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {entities.length} {entities.length === 1 ? 'entity' : 'entities'} · base currency {data?.baseCurrency ?? 'USD'} · each keeps its own fiscal calendar
          </p>
        </div>
        <Link href="/settings/new-entity"
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors">
          <Plus size={14} /> Add Company
        </Link>
      </div>

      {entities.length === 0 ? (
        <div className="py-10 text-center border border-dashed border-slate-800 rounded-lg">
          <Building2 className="w-8 h-8 mx-auto text-slate-600 mb-2" />
          <p className="text-sm text-slate-400">No entities yet.</p>
          <Link href="/settings/new-entity" className="text-sm text-emerald-400 hover:text-emerald-300 mt-1 inline-block">Add your first company</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {entities.map((e) => {
            const d = drafts[e.id] ?? { fiscalYearStartMonth: e.fiscalYearStartMonth, revRecMethod: e.revRecMethod };
            const dirty = isDirty(e);
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-800">
                <span className="w-10 h-10 rounded-lg bg-slate-700 text-[10px] font-mono text-slate-300 flex items-center justify-center shrink-0">{e.shortCode}</span>
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm text-white font-medium">{e.name}</p>
                  <p className="text-xs text-slate-500">{e.industry ?? 'Uncategorized'}</p>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-slate-500 mb-0.5">Fiscal Start</label>
                  <select value={d.fiscalYearStartMonth} className={selectCls}
                    onChange={(ev) => setDrafts((s) => ({ ...s, [e.id]: { ...d, fiscalYearStartMonth: Number(ev.target.value) } }))}>
                    {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-slate-500 mb-0.5">Revenue Recognition</label>
                  <select value={d.revRecMethod} className={selectCls}
                    onChange={(ev) => setDrafts((s) => ({ ...s, [e.id]: { ...d, revRecMethod: ev.target.value } }))}>
                    {Object.entries(REV_REC_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </div>
                <span className={clsx('px-2 py-0.5 rounded text-[10px] font-medium shrink-0', e.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-500')}>
                  {e.isActive ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => save(e)} disabled={!dirty || savingId === e.id}
                  className={clsx('flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0',
                    dirty ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-600 cursor-not-allowed')}>
                  {savingId === e.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
