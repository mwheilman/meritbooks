'use client';

import { useState, useCallback } from 'react';
import { Plus, Trash2, Loader2, AlertCircle, Route, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

interface Rule {
  id: string;
  match_type: 'VENDOR' | 'GL_CODE' | 'TRANSACTION_SOURCE' | 'DEFAULT';
  match_value: string | null;
  approver_type: 'ACCOUNTING' | 'RESPONSIBLE_PARTY' | 'PM_LEADER';
  approver_ref: string | null;
  priority: number;
  is_active: boolean;
}

interface VendorOption { id: string; name: string; display_name: string | null }
interface Employee { id: string; fullName: string }

const MATCH_LABEL: Record<string, string> = {
  VENDOR: 'Vendor',
  GL_CODE: 'GL account #',
  TRANSACTION_SOURCE: 'Source',
  DEFAULT: 'Default (all costs)',
};
const APPROVER_LABEL: Record<string, string> = {
  ACCOUNTING: 'Accounting',
  RESPONSIBLE_PARTY: 'Responsible party',
  PM_LEADER: 'PM / Leader',
};

export function CostRouting() {
  const { data, isLoading, error, refetch } = useQuery<{ data: Rule[] }>('/api/cost-approvals/rules');
  const { data: vendorData } = useQuery<{ data: VendorOption[] }>('/api/vendors?per_page=200');
  const vendors = vendorData?.data ?? [];

  const [matchType, setMatchType] = useState<Rule['match_type']>('DEFAULT');
  const [matchValue, setMatchValue] = useState('');
  const [approverType, setApproverType] = useState<Rule['approver_type']>('ACCOUNTING');
  const [approverRef, setApproverRef] = useState('');
  const [priority, setPriority] = useState('100');
  const [saving, setSaving] = useState(false);

  const { data: teamData } = useQuery<{ data: Employee[] }>(
    approverType === 'RESPONSIBLE_PARTY' || approverType === 'PM_LEADER' ? '/api/team' : null
  );
  const employees = teamData?.data ?? [];

  const rules = data?.data ?? [];

  const vendorName = useCallback((id: string | null) => {
    if (!id) return '—';
    const v = vendors.find((x) => x.id === id);
    return v ? (v.display_name ?? v.name) : id;
  }, [vendors]);

  const addRule = useCallback(async () => {
    if (matchType !== 'DEFAULT' && !matchValue) {
      addToast('error', 'Provide a match value');
      return;
    }
    if ((approverType === 'RESPONSIBLE_PARTY' || approverType === 'PM_LEADER') && !approverRef) {
      addToast('error', 'Pick a person for this approver type');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/cost-approvals/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          match_type: matchType,
          match_value: matchType === 'DEFAULT' ? null : matchValue,
          approver_type: approverType,
          approver_ref: approverType === 'ACCOUNTING' ? null : approverRef,
          priority: Number(priority) || 100,
          is_active: true,
        }),
      });
      const result = await res.json();
      if (!res.ok) { addToast('error', result.error ?? 'Failed to add rule'); return; }
      addToast('success', 'Routing rule added');
      setMatchValue(''); setApproverRef('');
      refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setSaving(false);
    }
  }, [matchType, matchValue, approverType, approverRef, priority, refetch]);

  const deleteRule = useCallback(async (id: string) => {
    const res = await fetch(`/api/cost-approvals/rules?id=${id}`, { method: 'DELETE' });
    if (res.ok) { addToast('success', 'Rule removed'); refetch(); }
    else addToast('error', 'Failed to remove rule');
  }, [refetch]);

  const inputCls = 'px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50';

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2"><Route size={18} className="text-emerald-400" /> Cost Approval Routing</h2>
        <p className="text-xs text-slate-500 mt-1">
          Decides who approves a job-tagged cost when a bill is entered. Most-specific match wins
          (Vendor &gt; GL account &gt; Source &gt; Default), then lowest priority number. Bank &amp; card
          charges clear automatically — these rules drive payables.
        </p>
      </div>

      {/* Add rule */}
      <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-4 space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 items-end">
          <div>
            <label className="block text-2xs text-slate-500 mb-1">When</label>
            <select value={matchType} onChange={(e) => { setMatchType(e.target.value as Rule['match_type']); setMatchValue(''); }} className={clsx(inputCls, 'w-full')}>
              <option value="DEFAULT">Default (all)</option>
              <option value="VENDOR">Vendor is</option>
              <option value="GL_CODE">GL account # is</option>
              <option value="TRANSACTION_SOURCE">Source is</option>
            </select>
          </div>
          <div>
            <label className="block text-2xs text-slate-500 mb-1">Value</label>
            {matchType === 'VENDOR' ? (
              <select value={matchValue} onChange={(e) => setMatchValue(e.target.value)} className={clsx(inputCls, 'w-full')}>
                <option value="">Select vendor…</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
              </select>
            ) : matchType === 'TRANSACTION_SOURCE' ? (
              <select value={matchValue} onChange={(e) => setMatchValue(e.target.value)} className={clsx(inputCls, 'w-full')}>
                <option value="">Select…</option>
                <option value="BILL">Bill</option>
                <option value="BANK_TXN">Bank/card</option>
              </select>
            ) : matchType === 'GL_CODE' ? (
              <input value={matchValue} onChange={(e) => setMatchValue(e.target.value)} placeholder="e.g. 5000" className={clsx(inputCls, 'w-full font-mono')} />
            ) : (
              <input disabled placeholder="—" className={clsx(inputCls, 'w-full opacity-40')} />
            )}
          </div>
          <div>
            <label className="block text-2xs text-slate-500 mb-1">Route to</label>
            <select value={approverType} onChange={(e) => { setApproverType(e.target.value as Rule['approver_type']); setApproverRef(''); }} className={clsx(inputCls, 'w-full')}>
              <option value="ACCOUNTING">Accounting</option>
              <option value="RESPONSIBLE_PARTY">Responsible party</option>
              <option value="PM_LEADER">PM / Leader</option>
            </select>
          </div>
          <div>
            <label className="block text-2xs text-slate-500 mb-1">Person</label>
            {approverType === 'ACCOUNTING' ? (
              <input disabled placeholder="—" className={clsx(inputCls, 'w-full opacity-40')} />
            ) : (
              <select value={approverRef} onChange={(e) => setApproverRef(e.target.value)} className={clsx(inputCls, 'w-full')}>
                <option value="">Select…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="block text-2xs text-slate-500 mb-1">Priority</label>
            <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className={clsx(inputCls, 'w-full font-mono')} />
          </div>
        </div>
        <button onClick={addRule} disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add rule
        </button>
      </div>

      {/* Existing rules */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-red-400"><AlertCircle size={16} /> {error}</div>
      ) : rules.length === 0 ? (
        <div className="text-center py-8 text-sm text-slate-500">
          No routing rules yet — every job cost routes to Accounting by default.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-slate-800/30 border border-slate-800">
              <span className="text-2xs font-mono text-slate-600 w-8">#{r.priority}</span>
              <div className="flex-1 text-sm text-slate-300">
                <span className="text-slate-500">{MATCH_LABEL[r.match_type]}</span>{' '}
                {r.match_type !== 'DEFAULT' && (
                  <span className="font-medium">
                    {r.match_type === 'VENDOR' ? vendorName(r.match_value) : r.match_value}
                  </span>
                )}{' '}
                <span className="text-slate-500">→</span>{' '}
                <span className="text-emerald-400">{APPROVER_LABEL[r.approver_type]}</span>
              </div>
              {r.is_active && <span className="inline-flex items-center gap-1 text-2xs text-emerald-400"><Check size={11} /> Active</span>}
              <button onClick={() => deleteRule(r.id)} className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
