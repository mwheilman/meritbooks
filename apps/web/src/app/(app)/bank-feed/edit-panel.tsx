'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Search, Check, Loader2, Bot, ChevronRight, Briefcase, AlertCircle, Layers, Building2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { ConfidenceBar } from '@/components/ui';
import type { BankFeedRow, JobSearchResult } from '@meritbooks/shared';
import type { ApproveBankTransactionInput } from '@/lib/validations/transactions';

interface EditPanelProps {
  transaction: BankFeedRow;
  locationId: string | null;
  onClose: () => void;
  onSave: () => void;
}

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type?: string;
  account_sub_type?: string;
}

interface AccountSearchResponse {
  recent: AccountOption[];
  accounts: AccountOption[];
}

interface DeptOption {
  id: string;
  name: string;
  code: string;
  locationId: string | null;
}

interface DeptResponse {
  departments: DeptOption[];
}

interface ClassOption {
  id: string;
  name: string;
  code: string;
}

interface EntityFlags {
  id: string;
  name: string;
  require_department?: boolean;
  require_class?: boolean;
  require_item?: boolean;
}

interface ApproveResult {
  success: boolean;
  entry_number: string;
  transaction_id: string;
}

// Display order for grouping the GL list by account type.
const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;
const TYPE_LABEL: Record<string, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  COGS: 'Cost of Goods Sold',
  OPEX: 'Operating Expenses',
  OTHER: 'Other',
};

function groupByType(accounts: AccountOption[]): Array<{ type: string; rows: AccountOption[] }> {
  const buckets = new Map<string, AccountOption[]>();
  for (const a of accounts) {
    const t = a.account_type ?? 'OTHER';
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(a);
  }
  const ordered: Array<{ type: string; rows: AccountOption[] }> = [];
  for (const t of TYPE_ORDER) {
    const rows = buckets.get(t);
    if (rows?.length) ordered.push({ type: t, rows });
  }
  // Any unexpected type goes last.
  for (const [t, rows] of buckets) {
    if (!TYPE_ORDER.includes(t as (typeof TYPE_ORDER)[number]) && rows.length) {
      ordered.push({ type: t, rows });
    }
  }
  return ordered;
}

export function EditPanel({ transaction, locationId, onClose, onSave }: EditPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [selectedAccount, setSelectedAccount] = useState<AccountOption | null>(
    transaction.ai_account ?? null
  );
  const [vendorName, setVendorName] = useState(
    transaction.ai_vendor?.display_name ?? transaction.ai_vendor?.name ?? ''
  );
  const [notes, setNotes] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [showAccountDropdown, setShowAccountDropdown] = useState(false);
  const debouncedSearch = useDebounce(accountSearch, 200);

  // Job selector state
  const [selectedJob, setSelectedJob] = useState<JobSearchResult | null>(
    transaction.final_job ? { ...transaction.final_job, customer_name: null, job_type: null, status: 'ACTIVE' } : null
  );
  const [jobSearch, setJobSearch] = useState('');
  const [showJobDropdown, setShowJobDropdown] = useState(false);
  const debouncedJobSearch = useDebounce(jobSearch, 200);
  const jobSearchRef = useRef<HTMLInputElement>(null);

  // Department + class state
  const [selectedDept, setSelectedDept] = useState<DeptOption | null>(null);
  const [showDeptDropdown, setShowDeptDropdown] = useState(false);
  const [selectedClass, setSelectedClass] = useState<ClassOption | null>(null);
  const [showClassDropdown, setShowClassDropdown] = useState(false);

  // Resolve the location for job/dimension scoping.
  const effectiveLocationId = locationId ?? transaction.location?.id ?? null;

  // Entity require_* flags (drive required-dimension validation).
  const { data: entities } = useQuery<EntityFlags[]>('/api/locations');
  const entity = useMemo(
    () => (entities ?? []).find((e) => e.id === effectiveLocationId) ?? null,
    [entities, effectiveLocationId]
  );
  const requireDept = entity?.require_department ?? false;
  const requireClass = entity?.require_class ?? false;

  // Departments (scoped to the entity, plus org-shared departments with no location).
  const { data: deptData } = useQuery<DeptResponse>('/api/departments');
  const departments = useMemo(() => {
    const all = deptData?.departments ?? [];
    return all.filter((d) => !d.locationId || d.locationId === effectiveLocationId);
  }, [deptData, effectiveLocationId]);

  // Classes (org-wide).
  const { data: classData } = useQuery<ClassOption[]>('/api/classes');
  const classes = classData ?? [];

  // Account search query
  const searchParams: Record<string, string> = {};
  if (debouncedSearch) searchParams.q = debouncedSearch;
  if (transaction.ai_vendor?.id) searchParams.vendor_id = transaction.ai_vendor.id;

  const { data: accountResults } = useQuery<AccountSearchResponse>(
    '/api/accounts/search',
    searchParams,
    { enabled: showAccountDropdown }
  );

  // Job search query
  const jobSearchParams: Record<string, string> = {};
  if (effectiveLocationId) jobSearchParams.location_id = effectiveLocationId;
  if (debouncedJobSearch) jobSearchParams.q = debouncedJobSearch;

  const { data: jobResults } = useQuery<JobSearchResult[]>(
    '/api/jobs/search',
    jobSearchParams,
    { enabled: showJobDropdown && !!effectiveLocationId }
  );

  // Required-dimension validation
  const isCogs = selectedAccount?.account_type === 'COGS';
  const jobRequired = isCogs;
  const jobMissing = jobRequired && !selectedJob;
  const deptMissing = requireDept && !selectedDept;
  const classMissing = requireClass && !selectedClass;
  const blockingMissing = jobMissing || deptMissing || classMissing;

  // Approve mutation
  const { mutate: approveTxn, isLoading: isSaving } = useMutation<
    ApproveBankTransactionInput,
    ApproveResult
  >('/api/bank-feed/approve');

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Close inline dropdowns on click outside their containers
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (searchInputRef.current && !searchInputRef.current.closest('.account-search-container')?.contains(t)) {
        setShowAccountDropdown(false);
      }
      if (jobSearchRef.current && !jobSearchRef.current.closest('.job-search-container')?.contains(t)) {
        setShowJobDropdown(false);
      }
      if (!(t as HTMLElement).closest?.('.dept-search-container')) setShowDeptDropdown(false);
      if (!(t as HTMLElement).closest?.('.class-search-container')) setShowClassDropdown(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSaveApprove = useCallback(async () => {
    if (!selectedAccount) {
      addToast('error', 'Select a GL account before approving');
      return;
    }
    if (jobMissing) {
      addToast('error', 'COGS accounts require a job assignment');
      return;
    }
    if (deptMissing) {
      addToast('error', `${entity?.name ?? 'This company'} requires a department on every entry`);
      return;
    }
    if (classMissing) {
      addToast('error', `${entity?.name ?? 'This company'} requires a class on every entry`);
      return;
    }

    const result = await approveTxn({
      transaction_id: transaction.id,
      account_id: selectedAccount.id,
      vendor_id: transaction.ai_vendor?.id ?? undefined,
      job_id: selectedJob?.id ?? undefined,
      department_id: selectedDept?.id ?? undefined,
      class_id: selectedClass?.id ?? undefined,
    });

    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      onSave();
    } else {
      // The DB validate_dimensions trigger may still reject for an
      // account-level required dimension; the mutation surfaces that message.
      addToast('error', 'Failed to approve — check required department/class/job');
    }
  }, [selectedAccount, transaction, approveTxn, onSave, selectedJob, selectedDept, selectedClass, jobMissing, deptMissing, classMissing, entity]);

  const isAlreadyPosted = transaction.status === 'POSTED' || transaction.status === 'APPROVED';
  const groupedAccounts = useMemo(
    () => groupByType(accountResults?.accounts ?? []),
    [accountResults]
  );

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-[480px] max-w-full bg-surface-900 border-l border-slate-800 z-50 flex flex-col animate-in slide-in-from-right duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-white">Edit Transaction</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Transaction summary */}
          <div className="rounded-lg bg-slate-800/40 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Transaction</span>
              <span className="text-sm font-mono tabular-nums text-slate-400">{transaction.transaction_date}</span>
            </div>
            <p className="text-sm text-slate-200 leading-relaxed">{transaction.description}</p>
            <div className="flex items-center justify-between pt-1">
              <span className={clsx(
                'text-lg font-mono tabular-nums font-semibold',
                transaction.amount_cents >= 0 ? 'text-emerald-400' : 'text-white'
              )}>
                {formatMoney(transaction.amount_cents)}
              </span>
              {transaction.ai_confidence != null && (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-slate-500">Confidence</span>
                  <ConfidenceBar value={transaction.ai_confidence} />
                </div>
              )}
            </div>
            {entity && (
              <div className="flex items-center gap-1.5 pt-1 text-2xs text-slate-500">
                <Building2 size={11} />
                <span>{entity.name}</span>
              </div>
            )}
          </div>

          {/* AI Reasoning */}
          {transaction.ai_reasoning && (
            <div>
              <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
                <Bot size={12} className="inline mr-1 -mt-0.5" />
                AI Reasoning
              </label>
              <div className="rounded-lg bg-indigo-500/5 border border-indigo-500/10 p-3">
                <p className="text-sm text-slate-300 leading-relaxed">{transaction.ai_reasoning}</p>
              </div>
            </div>
          )}

          {/* Vendor name */}
          <div>
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              Vendor
            </label>
            <input
              type="text"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="Vendor name..."
              className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 focus:border-brand-500/40"
            />
          </div>

          {/* GL Account (grouped by type) */}
          <div className="account-search-container">
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              GL Account
            </label>

            {selectedAccount && !showAccountDropdown && (
              <button
                onClick={() => {
                  setShowAccountDropdown(true);
                  setAccountSearch('');
                  setTimeout(() => searchInputRef.current?.focus(), 50);
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-left hover:border-slate-600 transition-colors group"
              >
                <span className="text-sm text-slate-200">
                  <span className="font-mono text-xs text-slate-400">{selectedAccount.account_number}</span>
                  {' · '}
                  {selectedAccount.name}
                </span>
                <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400" />
              </button>
            )}

            {(!selectedAccount || showAccountDropdown) && (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  onFocus={() => setShowAccountDropdown(true)}
                  placeholder="Search by account number or name..."
                  className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 focus:border-brand-500/40"
                  autoFocus={!selectedAccount}
                />
              </div>
            )}

            {showAccountDropdown && accountResults && (
              <div className="mt-1 max-h-72 overflow-y-auto rounded-md bg-slate-800 border border-slate-700 shadow-xl">
                {accountResults.recent.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-2xs text-indigo-400 uppercase tracking-wider font-semibold bg-slate-800/90 sticky top-0">
                      Recent for this vendor
                    </div>
                    {accountResults.recent.map((acct) => (
                      <AccountRow
                        key={acct.id}
                        account={acct}
                        isSelected={selectedAccount?.id === acct.id}
                        onSelect={() => { setSelectedAccount(acct); setShowAccountDropdown(false); setAccountSearch(''); }}
                      />
                    ))}
                  </>
                )}

                {groupedAccounts.map((group) => (
                  <div key={group.type}>
                    <div className="px-3 py-1.5 text-2xs text-slate-500 uppercase tracking-wider font-semibold bg-slate-800/90 sticky top-0">
                      {TYPE_LABEL[group.type] ?? group.type}
                    </div>
                    {group.rows.map((acct) => (
                      <AccountRow
                        key={acct.id}
                        account={acct}
                        isSelected={selectedAccount?.id === acct.id}
                        onSelect={() => { setSelectedAccount(acct); setShowAccountDropdown(false); setAccountSearch(''); }}
                      />
                    ))}
                  </div>
                ))}

                {accountResults.recent.length === 0 && groupedAccounts.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-600 text-center">No accounts found</div>
                )}
              </div>
            )}
          </div>

          {/* Department */}
          <DimensionPicker
            containerClass="dept-search-container"
            icon={<Building2 size={12} className="inline mr-1 -mt-0.5" />}
            label="Department"
            required={requireDept}
            open={showDeptDropdown}
            setOpen={setShowDeptDropdown}
            selectedLabel={selectedDept ? `${selectedDept.code} · ${selectedDept.name}` : null}
            onClear={() => setSelectedDept(null)}
            emptyHint={departments.length === 0 ? 'No departments for this company' : 'Select a department'}
            options={departments.map((d) => ({ id: d.id, label: `${d.code} · ${d.name}`, selected: selectedDept?.id === d.id }))}
            onSelect={(id) => { setSelectedDept(departments.find((d) => d.id === id) ?? null); setShowDeptDropdown(false); }}
            missing={deptMissing}
            missingMsg="This company requires a department on every entry"
          />

          {/* Class */}
          <DimensionPicker
            containerClass="class-search-container"
            icon={<Layers size={12} className="inline mr-1 -mt-0.5" />}
            label="Class"
            required={requireClass}
            open={showClassDropdown}
            setOpen={setShowClassDropdown}
            selectedLabel={selectedClass ? `${selectedClass.code} · ${selectedClass.name}` : null}
            onClear={() => setSelectedClass(null)}
            emptyHint={classes.length === 0 ? 'No classes defined' : 'Select a class'}
            options={classes.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}`, selected: selectedClass?.id === c.id }))}
            onSelect={(id) => { setSelectedClass(classes.find((c) => c.id === id) ?? null); setShowClassDropdown(false); }}
            missing={classMissing}
            missingMsg="This company requires a class on every entry"
          />

          {/* Job / Project */}
          <div className="job-search-container">
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              <Briefcase size={12} className="inline mr-1 -mt-0.5" />
              Job / Project
              {jobRequired && <span className="text-red-400 ml-1">*</span>}
              {!jobRequired && <span className="text-slate-600 ml-1">(optional)</span>}
            </label>

            {selectedJob && !showJobDropdown && (
              <button
                onClick={() => {
                  setShowJobDropdown(true);
                  setJobSearch('');
                  setTimeout(() => jobSearchRef.current?.focus(), 50);
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-left hover:border-slate-600 transition-colors group"
              >
                <span className="text-sm text-slate-200">
                  <span className="font-mono text-xs text-slate-400">{selectedJob.job_number}</span>
                  {' · '}
                  {selectedJob.name}
                  {selectedJob.customer_name && (
                    <span className="text-slate-500 ml-1">({selectedJob.customer_name})</span>
                  )}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedJob(null); }}
                    className="p-0.5 rounded hover:bg-white/[0.08] text-slate-600 hover:text-slate-300"
                    aria-label="Clear job"
                  >
                    <X size={12} />
                  </button>
                  <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400" />
                </div>
              </button>
            )}

            {(!selectedJob || showJobDropdown) && (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                <input
                  ref={jobSearchRef}
                  type="text"
                  value={jobSearch}
                  onChange={(e) => setJobSearch(e.target.value)}
                  onFocus={() => setShowJobDropdown(true)}
                  placeholder={effectiveLocationId ? 'Search by job number or name...' : 'Select a company first'}
                  disabled={!effectiveLocationId}
                  className="w-full pl-9 pr-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 focus:border-brand-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            )}

            {showJobDropdown && effectiveLocationId && jobResults && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded-md bg-slate-800 border border-slate-700 shadow-xl">
                {jobResults.length > 0 ? (
                  jobResults.map((job) => (
                    <button
                      key={job.id}
                      onClick={() => { setSelectedJob(job); setShowJobDropdown(false); setJobSearch(''); }}
                      className={clsx(
                        'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                        selectedJob?.id === job.id ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
                      )}
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-xs text-slate-400">{job.job_number}</span>
                        <span className="ml-2 text-sm truncate">{job.name}</span>
                        {job.customer_name && (
                          <span className="ml-1 text-xs text-slate-500">({job.customer_name})</span>
                        )}
                      </div>
                      <span className="text-2xs text-slate-600 shrink-0 ml-2">{job.status}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-4 text-sm text-slate-600 text-center">No jobs found</div>
                )}
              </div>
            )}

            {jobMissing && (
              <div className="mt-1.5 flex items-center gap-1.5 text-red-400 text-xs">
                <AlertCircle size={12} />
                <span>COGS account — job assignment is required for cost tracking</span>
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes about this transaction..."
              rows={3}
              className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 focus:border-brand-500/40 resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveApprove}
            disabled={!selectedAccount || isSaving || isAlreadyPosted || blockingMissing}
            className={clsx(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
              !selectedAccount || isAlreadyPosted || blockingMissing
                ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            )}
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {isAlreadyPosted ? 'Already Posted' : 'Save & Approve'}
          </button>
        </div>
      </div>
    </>
  );
}

function AccountRow({ account, isSelected, onSelect }: {
  account: AccountOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
        isSelected ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
      )}
    >
      <div>
        <span className="font-mono text-xs text-slate-400">{account.account_number}</span>
        <span className="ml-2 text-sm">{account.name}</span>
      </div>
      {isSelected && <Check size={14} className="text-brand-400" />}
    </button>
  );
}

/** Compact single-select dropdown used for the Department and Class dimensions. */
function DimensionPicker(props: {
  containerClass: string;
  icon: React.ReactNode;
  label: string;
  required: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  selectedLabel: string | null;
  onClear: () => void;
  emptyHint: string;
  options: Array<{ id: string; label: string; selected: boolean }>;
  onSelect: (id: string) => void;
  missing: boolean;
  missingMsg: string;
}) {
  const { containerClass, icon, label, required, open, setOpen, selectedLabel, onClear, emptyHint, options, onSelect, missing, missingMsg } = props;
  return (
    <div className={containerClass}>
      <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
        {icon}
        {label}
        {required ? <span className="text-red-400 ml-1">*</span> : <span className="text-slate-600 ml-1">(optional)</span>}
      </label>

      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-left hover:border-slate-600 transition-colors group"
      >
        <span className={clsx('text-sm', selectedLabel ? 'text-slate-200' : 'text-slate-600')}>
          {selectedLabel ?? emptyHint}
        </span>
        <div className="flex items-center gap-1">
          {selectedLabel && (
            <button
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="p-0.5 rounded hover:bg-white/[0.08] text-slate-600 hover:text-slate-300"
              aria-label={`Clear ${label.toLowerCase()}`}
            >
              <X size={12} />
            </button>
          )}
          <ChevronRight size={14} className={clsx('text-slate-600 transition-transform', open && 'rotate-90')} />
        </div>
      </button>

      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md bg-slate-800 border border-slate-700 shadow-xl">
          {options.length > 0 ? (
            options.map((o) => (
              <button
                key={o.id}
                onClick={() => onSelect(o.id)}
                className={clsx(
                  'w-full flex items-center justify-between px-3 py-2 text-left text-sm transition-colors',
                  o.selected ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
                )}
              >
                <span>{o.label}</span>
                {o.selected && <Check size={14} className="text-brand-400" />}
              </button>
            ))
          ) : (
            <div className="px-3 py-4 text-sm text-slate-600 text-center">{emptyHint}</div>
          )}
        </div>
      )}

      {missing && (
        <div className="mt-1.5 flex items-center gap-1.5 text-red-400 text-xs">
          <AlertCircle size={12} />
          <span>{missingMsg}</span>
        </div>
      )}
    </div>
  );
}
