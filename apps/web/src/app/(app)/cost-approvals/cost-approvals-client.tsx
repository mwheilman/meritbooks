'use client';

import { useState, useEffect, useCallback } from 'react';
import { Check, X, Loader2, Plus, Trash2, RefreshCw, CircleDollarSign } from 'lucide-react';

interface Company { id: string; name: string; short_code: string }
interface Job { id: string; name: string; job_number?: string }
interface Attribution {
  id: string; lifecycle: string; cost_type: string; gate: string; amount_cents: number;
  occurred_on: string; approver_type: string; approver_ref: string | null; source_type: string;
  job: { name: string; job_number?: string } | null; company: { name: string; short_code: string } | null;
}
interface Rule { id: string; match_type: string; match_value: string | null; approver_type: string; approver_ref: string | null; priority: number }
interface BillingEvent { event_id: string; status: string; invoice_id: string | null; error: string | null; occurred_on: string; payload: { job_id: string; billing_type: string; lines?: { amount_cents: number }[] } }

const fmt = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const COST_TYPES = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'];
const GATES = ['PAYABLE_APPROVAL', 'BANKFEED_CATEGORIZATION', 'TIMESHEET_PAYROLL'];
const APPROVERS = ['ACCOUNTING', 'RESPONSIBLE_PARTY', 'PM_LEADER'];

export function CostApprovalsClient() {
  const [tab, setTab] = useState<'queue' | 'rules' | 'billing'>('queue');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch('/api/locations').then((r) => r.ok ? r.json() : []).then((d) => setCompanies(Array.isArray(d) ? d : [])).catch(() => {});
    fetch('/api/jobs').then((r) => r.ok ? r.json() : { data: [] }).then((d) => setJobs(Array.isArray(d) ? d : (d.data ?? []))).catch(() => {});
  }, []);

  return (
    <div className="max-w-4xl">
      <div className="flex gap-1 mb-5 border-b border-slate-800">
        {([['queue', 'Pending costs'], ['rules', 'Routing rules'], ['billing', 'Billing inbox']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === k ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
            {label}
          </button>
        ))}
      </div>
      {msg && <p className="text-xs text-emerald-400 mb-3">{msg}</p>}
      {tab === 'queue' && <Queue companies={companies} jobs={jobs} busy={busy} setBusy={setBusy} setMsg={setMsg} />}
      {tab === 'rules' && <Rules busy={busy} setBusy={setBusy} setMsg={setMsg} />}
      {tab === 'billing' && <Billing busy={busy} setBusy={setBusy} setMsg={setMsg} />}
    </div>
  );
}

function Queue({ companies, jobs, busy, setBusy, setMsg }: { companies: Company[]; jobs: Job[]; busy: boolean; setBusy: (b: boolean) => void; setMsg: (m: string) => void }) {
  const [rows, setRows] = useState<Attribution[]>([]);
  const [lifecycle, setLifecycle] = useState('PENDING');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ location_id: '', job_id: '', cost_type: 'MATERIALS', gate: 'PAYABLE_APPROVAL', amount: '', occurred_on: new Date().toISOString().split('T')[0], memo: '' });

  const load = useCallback(async () => {
    const res = await fetch(`/api/cost-approvals?lifecycle=${lifecycle}`);
    const data = await res.json();
    setRows(data.data ?? []);
  }, [lifecycle]);
  useEffect(() => { load(); }, [load]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/cost-approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) { setMsg(d.error ?? 'Action failed'); return; }
      await load();
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (!form.location_id || !form.job_id || !form.amount) { setMsg('Company, job, and amount are required'); return; }
    await act({ action: 'create', location_id: form.location_id, job_id: form.job_id, cost_type: form.cost_type, gate: form.gate, amount_cents: Math.round(Number(form.amount.replace(/[$,\s]/g, '')) * 100), occurred_on: form.occurred_on, source_type: 'MANUAL', memo: form.memo });
    setShowNew(false); setForm({ ...form, amount: '', memo: '' });
    setMsg('Cost attributed — JOB_COST event emitted.');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} className="rounded-lg border border-slate-700 bg-surface-900 px-3 py-1.5 text-sm text-white">
          <option value="PENDING">Pending</option><option value="CLEARED">Cleared</option><option value="VOIDED">Voided</option><option value="all">All</option>
        </select>
        <button onClick={() => setShowNew((s) => !s)} className="inline-flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-200"><Plus size={15} /> Attribute a cost</button>
      </div>

      {showNew && (
        <div className="rounded-xl border border-slate-800 bg-surface-900 p-4 mb-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-400">Company<select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white"><option value="">Select…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="text-xs text-slate-400">Job<select value={form.job_id} onChange={(e) => setForm({ ...form, job_id: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white"><option value="">Select…</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number ? `${j.job_number} · ` : ''}{j.name}</option>)}</select></label>
          <label className="text-xs text-slate-400">Cost type<select value={form.cost_type} onChange={(e) => setForm({ ...form, cost_type: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white">{COST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          <label className="text-xs text-slate-400">Gate<select value={form.gate} onChange={(e) => setForm({ ...form, gate: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white">{GATES.map((g) => <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>)}</select></label>
          <label className="text-xs text-slate-400">Amount<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white font-mono" /></label>
          <label className="text-xs text-slate-400">Date<input type="date" value={form.occurred_on} onChange={(e) => setForm({ ...form, occurred_on: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white" /></label>
          <div className="col-span-2 flex justify-end"><button onClick={create} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Attribute & emit</button></div>
          <p className="col-span-2 text-2xs text-slate-500">Bank-feed costs clear immediately; payables &amp; labor start pending and route for approval.</p>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="grid grid-cols-[1fr_90px_110px_120px_100px] gap-2 px-3 py-2 bg-surface-900/60 text-2xs uppercase tracking-wider text-slate-500">
          <span>Job / Company</span><span className="text-right">Amount</span><span>Type / Gate</span><span>Routed to</span><span></span>
        </div>
        {rows.length === 0 ? <p className="px-3 py-6 text-sm text-slate-500 text-center">No {lifecycle.toLowerCase()} costs.</p> : rows.map((r) => (
          <div key={r.id} className="grid grid-cols-[1fr_90px_110px_120px_100px] gap-2 px-3 py-2.5 items-center border-t border-slate-800 text-sm">
            <div className="min-w-0"><p className="text-slate-200 truncate">{r.job?.name ?? '—'}</p><p className="text-2xs text-slate-500">{r.company?.short_code} · {r.occurred_on}</p></div>
            <span className="text-right font-mono text-slate-200">{fmt(r.amount_cents)}</span>
            <div className="text-2xs text-slate-400">{r.cost_type}<br /><span className="text-slate-600">{r.gate.replace(/_/g, ' ')}</span></div>
            <span className="text-2xs text-slate-400">{r.approver_type}{r.approver_ref ? ` (${r.approver_ref})` : ''}</span>
            <div className="flex justify-end gap-1">
              {r.lifecycle === 'PENDING' && <>
                <button title="Approve (clear)" onClick={() => act({ action: 'approve', id: r.id })} disabled={busy} className="p-1.5 rounded-md bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"><Check size={14} /></button>
                <button title="Void" onClick={() => act({ action: 'void', id: r.id, reason: 'Rejected by approver' })} disabled={busy} className="p-1.5 rounded-md bg-rose-600/20 text-rose-300 hover:bg-rose-600/30"><X size={14} /></button>
              </>}
              {r.lifecycle !== 'PENDING' && <span className={`text-2xs ${r.lifecycle === 'CLEARED' ? 'text-emerald-400' : 'text-slate-500'}`}>{r.lifecycle}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Rules({ busy, setBusy, setMsg }: { busy: boolean; setBusy: (b: boolean) => void; setMsg: (m: string) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [form, setForm] = useState({ match_type: 'DEFAULT', match_value: '', approver_type: 'ACCOUNTING', approver_ref: '', priority: '100' });

  const load = useCallback(async () => { const r = await fetch('/api/cost-approvals/rules'); const d = await r.json(); setRules(d.data ?? []); }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/cost-approvals/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ match_type: form.match_type, match_value: form.match_value || null, approver_type: form.approver_type, approver_ref: form.approver_ref || null, priority: Number(form.priority) }) });
      const d = await res.json(); if (!res.ok) { setMsg(d.error ?? 'Failed'); return; }
      setForm({ ...form, match_value: '', approver_ref: '' }); await load();
    } finally { setBusy(false); }
  };
  const del = async (id: string) => { setBusy(true); try { await fetch(`/api/cost-approvals/rules?id=${id}`, { method: 'DELETE' }); await load(); } finally { setBusy(false); } };

  return (
    <div>
      <div className="rounded-xl border border-slate-800 bg-surface-900 p-4 mb-4 grid grid-cols-5 gap-2 items-end">
        <label className="text-xs text-slate-400 col-span-1">Match<select value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white"><option value="DEFAULT">Default</option><option value="VENDOR">Vendor</option><option value="GL_CODE">GL code</option><option value="TRANSACTION_SOURCE">Txn source</option></select></label>
        <label className="text-xs text-slate-400 col-span-1">Value{form.match_type === 'DEFAULT' ? ' (n/a)' : ''}<input value={form.match_value} onChange={(e) => setForm({ ...form, match_value: e.target.value })} disabled={form.match_type === 'DEFAULT'} placeholder={form.match_type === 'GL_CODE' ? '5000' : form.match_type === 'VENDOR' ? 'vendor id' : ''} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white disabled:opacity-40" /></label>
        <label className="text-xs text-slate-400 col-span-1">Approver<select value={form.approver_type} onChange={(e) => setForm({ ...form, approver_type: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white">{APPROVERS.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}</select></label>
        <label className="text-xs text-slate-400 col-span-1">Approver ref<input value={form.approver_ref} onChange={(e) => setForm({ ...form, approver_ref: e.target.value })} placeholder="user/employee id" className="mt-1 w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-sm text-white" /></label>
        <button onClick={add} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"><Plus size={15} /> Add</button>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        {rules.length === 0 ? <p className="px-3 py-6 text-sm text-slate-500 text-center">No routing rules — costs default to direct accounting approval.</p> : rules.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-t border-slate-800 first:border-t-0 text-sm">
            <span className="text-2xs font-mono text-slate-500 w-8">{r.priority}</span>
            <span className="text-slate-200">{r.match_type}{r.match_value ? `: ${r.match_value}` : ''}</span>
            <span className="text-slate-600">→</span>
            <span className="text-slate-300">{r.approver_type}{r.approver_ref ? ` (${r.approver_ref})` : ''}</span>
            <button onClick={() => del(r.id)} className="ml-auto p-1.5 rounded-md text-slate-500 hover:text-rose-300 hover:bg-rose-600/10"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Billing({ busy, setBusy, setMsg }: { busy: boolean; setBusy: (b: boolean) => void; setMsg: (m: string) => void }) {
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const load = useCallback(async () => { const r = await fetch('/api/events/billing/process'); const d = await r.json(); setEvents(d.data ?? []); }, []);
  useEffect(() => { load(); }, [load]);

  const drain = async () => {
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/events/billing/process', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) { setMsg(d.error ?? 'Drain failed'); return; }
      setMsg(`Processed ${d.processed ?? 0}, rejected ${d.rejected ?? 0}.`);
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-slate-400">Billing requests emitted by Projects (JOB_BILLING). Processing issues an invoice and posts AR + revenue/deferred per the company's rev-rec.</p>
        <button onClick={drain} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500 disabled:opacity-50 shrink-0"><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> Process pending</button>
      </div>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_110px_1fr] gap-2 px-3 py-2 bg-surface-900/60 text-2xs uppercase tracking-wider text-slate-500">
          <span>Event</span><span className="text-right">Amount</span><span>Status</span><span>Result</span>
        </div>
        {events.length === 0 ? <p className="px-3 py-6 text-sm text-slate-500 text-center flex items-center justify-center gap-2"><CircleDollarSign size={15} /> No billing events yet.</p> : events.map((e) => {
          const amt = (e.payload?.lines ?? []).reduce((s, l) => s + Number(l.amount_cents ?? 0), 0);
          return (
            <div key={e.event_id} className="grid grid-cols-[1fr_100px_110px_1fr] gap-2 px-3 py-2.5 items-center border-t border-slate-800 text-sm">
              <span className="text-2xs font-mono text-slate-400 truncate">{e.payload?.billing_type} · {e.occurred_on}</span>
              <span className="text-right font-mono text-slate-200">{fmt(amt)}</span>
              <span className={`text-2xs ${e.status === 'processed' ? 'text-emerald-400' : e.status === 'rejected' ? 'text-rose-400' : 'text-amber-400'}`}>{e.status}</span>
              <span className="text-2xs text-slate-500 truncate">{e.invoice_id ? 'invoice issued' : e.error ?? 'awaiting processing'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
