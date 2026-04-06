'use client';

import { useState, useCallback } from 'react';
import {
  Search, Plus, Check, X, Lock, Building2, CreditCard, Landmark,
  Loader2, AlertCircle, ChevronDown, ChevronRight, Shield, Clock
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, useMutation } from '@/hooks';
import { PageHeader } from '@/components/ui';

// ─── Types ──────────────────────────────────────────────────

interface AccountRow {
  id: string;
  accountNumber: string;
  name: string;
  accountType: string;
  groupName: string;
  subTypeName: string;
  typeName: string;
  isActive: boolean;
  isControlAccount: boolean;
  isCompanySpecific: boolean;
  isBankAccount: boolean;
  isCreditCard: boolean;
  approvalStatus: string;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  requireDepartment: boolean;
  requireClass: boolean;
  requireItem: boolean;
  createdAt: string;
}

interface AccountsResponse {
  data: AccountRow[];
  counts: { pending: number; approved: number; total: number };
}

// ─── Main Page ──────────────────────────────────────────────

export default function ChartOfAccountsPage() {
  const [showRequest, setShowRequest] = useState(false);
  const [tab, setTab] = useState<'all' | 'pending'>('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const params: Record<string, string> = {};
  if (tab === 'pending') params.approval_status = 'PENDING';
  if (typeFilter) params.account_type = typeFilter;

  const { data, isLoading, error, refetch } = useQuery<AccountsResponse>(
    '/api/accounts', Object.keys(params).length > 0 ? params : undefined,
    { key: String(refreshKey) }
  );

  const accounts = data?.data ?? [];
  const counts = data?.counts;

  const filtered = search
    ? accounts.filter((a) =>
        a.accountNumber.includes(search) ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.groupName.toLowerCase().includes(search.toLowerCase())
      )
    : accounts;

  // Group by type → subType → group
  const typeGroups = new Map<string, Map<string, Map<string, AccountRow[]>>>();
  for (const acct of filtered) {
    if (!typeGroups.has(acct.typeName)) typeGroups.set(acct.typeName, new Map());
    const stMap = typeGroups.get(acct.typeName)!;
    if (!stMap.has(acct.subTypeName)) stMap.set(acct.subTypeName, new Map());
    const gMap = stMap.get(acct.subTypeName)!;
    if (!gMap.has(acct.groupName)) gMap.set(acct.groupName, []);
    gMap.get(acct.groupName)!.push(acct);
  }

  const handleApproval = useCallback(async (accountId: string, action: 'approve' | 'reject') => {
    await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, action }),
    });
    setRefreshKey((k) => k + 1);
  }, []);

  const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chart of Accounts"
        description={`${counts?.total ?? 0} accounts · ${counts?.pending ?? 0} pending approval`}
        actions={
          <button
            onClick={() => setShowRequest(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
          >
            <Plus size={16} /> Request Account
          </button>
        }
      />

      {showRequest && (
        <RequestAccountForm
          onClose={() => setShowRequest(false)}
          onSuccess={() => { setShowRequest(false); setRefreshKey((k) => k + 1); }}
        />
      )}

      {/* Tabs + filters */}
      <div className="flex items-center gap-4">
        <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-800">
          <button onClick={() => setTab('all')} className={clsx('px-3 py-1.5 rounded-md text-xs font-medium', tab === 'all' ? 'bg-slate-700 text-white' : 'text-slate-500')}>
            All <span className="font-mono ml-1 text-slate-600">{counts?.total ?? 0}</span>
          </button>
          <button onClick={() => setTab('pending')} className={clsx('px-3 py-1.5 rounded-md text-xs font-medium', tab === 'pending' ? 'bg-slate-700 text-white' : 'text-slate-500')}>
            Pending <span className="font-mono ml-1 text-amber-500">{counts?.pending ?? 0}</span>
          </button>
        </div>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white"
        >
          <option value="">All Types</option>
          {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-500"
          />
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-500">
          {tab === 'pending' ? 'No pending account requests.' : 'No accounts found.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-20">Number</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Name</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Type</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Group</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-20">Status</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-16">Flags</th>
                {tab === 'pending' && <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-28">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {filtered.map((acct) => (
                <tr key={acct.id} className="hover:bg-slate-800/20">
                  <td className="px-4 py-2 text-xs font-mono text-emerald-400">{acct.accountNumber}</td>
                  <td className="px-4 py-2 text-slate-300">{acct.name}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{acct.accountType}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">{acct.groupName}</td>
                  <td className="px-4 py-2 text-center">
                    {acct.approvalStatus === 'PENDING' ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400"><Clock size={9} />Pending</span>
                    ) : acct.approvalStatus === 'APPROVED' ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400"><Check size={9} />Active</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400"><X size={9} />Rejected</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {acct.isControlAccount && <Lock size={11} className="text-amber-500/60" />}
                      {acct.isCompanySpecific && <Building2 size={11} className="text-blue-400/60" />}
                      {acct.isBankAccount && <Landmark size={11} className="text-slate-500" />}
                      {acct.isCreditCard && <CreditCard size={11} className="text-slate-500" />}
                    </div>
                  </td>
                  {tab === 'pending' && (
                    <td className="px-4 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleApproval(acct.id, 'approve')}
                          className="p-1 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                        ><Check size={13} /></button>
                        <button
                          onClick={() => handleApproval(acct.id, 'reject')}
                          className="p-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        ><X size={13} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Request Account Form ───────────────────────────────────

function RequestAccountForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [accountNumber, setAccountNumber] = useState('');
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState('');
  const [groupId, setGroupId] = useState('');
  const [isCompanySpecific, setIsCompanySpecific] = useState(false);
  const [reqDept, setReqDept] = useState(false);
  const [reqClass, setReqClass] = useState(false);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');

  const { mutate, isLoading: submitting } = useMutation<Record<string, unknown>, { success: boolean; message: string }>(
    '/api/accounts'
  );

  // Load account groups for the picker
  const { data: groupData } = useQuery<{ id: string; name: string; display_order: number }[]>(
    '/api/accounts/search?meta=groups'
  );

  const handleSubmit = async () => {
    setFormError('');
    if (!accountNumber || !name || !accountType) {
      setFormError('Account number, name, and type are required');
      return;
    }

    const result = await mutate({
      account_number: accountNumber,
      name,
      account_type: accountType,
      account_group_id: groupId || undefined,
      is_company_specific: isCompanySpecific,
      require_department: reqDept,
      require_class: reqClass,
      notes: notes || undefined,
    });

    if (result?.success) {
      onSuccess();
    } else {
      setFormError('Failed to request account');
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <h2 className="text-lg font-semibold text-white">Request New Account</h2>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"><X size={18} /></button>
      </div>
      <div className="p-6 space-y-4">
        <p className="text-xs text-slate-500 bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">
          New accounts require CFO or Controller approval before they can receive postings.
        </p>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Account Number</label>
            <input
              type="text"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="e.g. 61500"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Account Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Equipment Rental"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Account Type</label>
            <select
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
            >
              <option value="">Select type...</option>
              <option value="ASSET">Asset (10000-19999)</option>
              <option value="LIABILITY">Liability (20000-29999)</option>
              <option value="EQUITY">Equity (30000-39999)</option>
              <option value="REVENUE">Revenue (40000-49999)</option>
              <option value="COGS">Cost of Goods Sold (50000-59999)</option>
              <option value="OPEX">Operating Expense (60000-69999)</option>
              <option value="OTHER">Other Income/Expense (70000-99999)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={isCompanySpecific} onChange={(e) => setIsCompanySpecific(e.target.checked)} className="rounded border-slate-600 bg-slate-800 text-emerald-500" />
            Company-specific
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={reqDept} onChange={(e) => setReqDept(e.target.checked)} className="rounded border-slate-600 bg-slate-800 text-emerald-500" />
            Require department
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={reqClass} onChange={(e) => setReqClass(e.target.checked)} className="rounded border-slate-600 bg-slate-800 text-emerald-500" />
            Require class
          </label>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">Notes (visible to approver)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 resize-none"
            placeholder="Why is this account needed?"
          />
        </div>

        {formError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle size={13} className="text-red-400" />
            <p className="text-xs text-red-400">{formError}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !accountNumber || !name || !accountType}
            className={clsx(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium',
              submitting || !accountNumber || !name || !accountType
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            )}
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
            Request Account
          </button>
        </div>
      </div>
    </div>
  );
}
