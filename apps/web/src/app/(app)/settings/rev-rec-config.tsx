'use client';

import { useState, useCallback } from 'react';
import { Loader2, AlertCircle, Plus, Trash2, Percent, Zap, Pencil } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

interface MethodOpt { value: string; label: string; poc: boolean }
interface MapRule { id: string; jobType: string; method: string }
interface Company { locationId: string; name: string; shortCode: string; defaultMethod: string; map: MapRule[] }
interface ConfigResponse {
  methods: MethodOpt[];
  projectsEntitled: boolean;
  inputMode: 'AUTO_FED' | 'DIRECT_ENTRY';
  companies: Company[];
}

export function RevRecConfig() {
  const { data, isLoading, error, refetch } = useQuery<ConfigResponse>('/api/rev-rec/config');
  const [draft, setDraft] = useState<Record<string, { jobType: string; method: string }>>({});

  const methods = data?.methods ?? [];
  const methodLabel = useCallback((v: string) => methods.find((m) => m.value === v)?.label ?? v, [methods]);

  const setDefault = useCallback(async (locationId: string, method: string) => {
    const res = await fetch('/api/rev-rec/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'default', location_id: locationId, method }) });
    if (!res.ok) { addToast('error', (await res.json()).error ?? 'Failed'); return; }
    addToast('success', 'Company default updated');
    refetch();
  }, [refetch]);

  const addRule = useCallback(async (locationId: string) => {
    const d = draft[locationId];
    if (!d?.jobType || !d?.method) { addToast('error', 'Enter a job type and method'); return; }
    const res = await fetch('/api/rev-rec/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'map', location_id: locationId, job_type: d.jobType, method: d.method }) });
    if (!res.ok) { addToast('error', (await res.json()).error ?? 'Failed'); return; }
    addToast('success', 'Mapping saved');
    setDraft((s) => ({ ...s, [locationId]: { jobType: '', method: '' } }));
    refetch();
  }, [draft, refetch]);

  const removeRule = useCallback(async (id: string) => {
    const res = await fetch(`/api/rev-rec/config?id=${id}`, { method: 'DELETE' });
    if (!res.ok) { addToast('error', (await res.json()).error ?? 'Failed'); return; }
    addToast('success', 'Mapping removed');
    refetch();
  }, [refetch]);

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>;
  if (error || !data) return <div className="card p-6 text-center"><AlertCircle className="mx-auto text-red-400 mb-2" size={20} /><p className="text-sm text-red-400">{error ?? 'Failed to load'}</p></div>;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-white flex items-center gap-2"><Percent size={16} className="text-brand-400" /> Revenue Recognition</h2>
        <p className="text-sm text-slate-500 mt-1">
          Method resolves per job: <span className="text-slate-300">job override → job-type mapping → company default</span>. One company can run several methods at once.
        </p>
      </div>

      <div className={clsx('flex items-start gap-2 px-4 py-2.5 rounded-lg border text-xs',
        data.inputMode === 'AUTO_FED' ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-300' : 'bg-slate-800/40 border-slate-700/50 text-slate-400')}>
        {data.inputMode === 'AUTO_FED' ? <Zap size={14} className="mt-0.5 shrink-0" /> : <Pencil size={14} className="mt-0.5 shrink-0" />}
        <p>
          {data.inputMode === 'AUTO_FED'
            ? 'MeritProjects is connected — contract value, cost estimate, and % complete are fed automatically via JOB_PROGRESS and pinned on each job.'
            : 'Standalone mode — accounting keys contract value, cost estimate, and % complete directly on each job (Jobs → job → Recognition inputs). Connect MeritProjects to auto-feed these.'}
        </p>
      </div>

      {data.companies.map((c) => {
        const d = draft[c.locationId] ?? { jobType: '', method: '' };
        return (
          <div key={c.locationId} className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{c.shortCode}</span>
                <span className="text-sm font-medium text-slate-200">{c.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-2xs uppercase tracking-wider text-slate-500">Default</label>
                <select value={c.defaultMethod} onChange={(e) => setDefault(c.locationId, e.target.value)}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white">
                  {methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>

            {/* job_type → method rules */}
            <div className="space-y-1.5">
              {c.map.length === 0 && <p className="text-2xs text-slate-600">No job-type overrides — every job uses the company default unless the job itself overrides.</p>}
              {c.map.map((r) => (
                <div key={r.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/30">
                  <span className="text-sm text-slate-300 flex-1 truncate">{r.jobType}</span>
                  <span className="text-2xs text-slate-500">→</span>
                  <span className="text-xs text-slate-300">{methodLabel(r.method)}</span>
                  <button onClick={() => removeRule(r.id)} className="p-1 text-slate-500 hover:text-red-400"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>

            {/* add rule */}
            <div className="flex items-center gap-2 pt-1">
              <input value={d.jobType} onChange={(e) => setDraft((s) => ({ ...s, [c.locationId]: { ...d, jobType: e.target.value } }))}
                placeholder="job_type (e.g. construction)" className="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white" />
              <select value={d.method} onChange={(e) => setDraft((s) => ({ ...s, [c.locationId]: { ...d, method: e.target.value } }))}
                className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-white">
                <option value="">method…</option>
                {methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button onClick={() => addRule(c.locationId)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-emerald-600 text-white hover:bg-emerald-500"><Plus size={13} /> Add</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
