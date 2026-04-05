'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Search, Check, Loader2, Bot, ChevronRight, Briefcase, AlertCircle } from 'lucide-react';
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

interface ApproveResult {
  success: boolean;
  entry_number: string;
  transaction_id: string;
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

  // Derive whether job is required: COGS account type
  const isCogs = selectedAccount?.account_type === 'COGS';
  const jobRequired = isCogs;
  const jobMissing = jobRequired && !selectedJob;

  // Resolve the location for job search: prefer explicit, fall back to transaction's location
  const effectiveLocationId = locationId ?? transaction.location?.id ?? null;

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

  // Close account dropdown on click outside search area
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchInputRef.current && !searchInputRef.current.closest('.account-search-container')?.contains(e.target as Node)) {
        setShowAccountDropdown(false);
      }
      if (jobSearchRef.current && !jobSearchRef.current.closest('.job-search-container')?.contains(e.target as Node)) {
        setShowJobDropdown(false);
      }
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

    const result = await approveTxn({
      transaction_id: transaction.id,
      account_id: selectedAccount.id,
      vendor_id: transaction.ai_vendor?.id ?? undefined,
      job_id: selectedJob?.id ?? undefined,
    });

    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      onSave();
    } else {
      addToast('error', 'Failed to approve transaction');
    }
  }, [selectedAccount, transaction, approveTxn, onSave, selectedJob, jobMissing]);

  const isAlreadyPosted = transaction.status === 'POSTED' || transaction.status === 'APPROVED';

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

          {/* GL Account */}
          <div className="account-search-container">
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              GL Account
            </label>

            {/* Selected account display */}
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

            {/* Search input */}
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

            {/* Account dropdown */}
            {showAccountDropdown && accountResults && (
              <div className="mt-1 max-h-64 overflow-y-auto rounded-md bg-slate-800 border border-slate-700 shadow-xl">
                {/* Vendor-specific recent accounts */}
                {accountResults.recent.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-2xs text-indigo-400 uppercase tracking-wider font-semibold bg-slate-800/80 sticky top-0">
                      Recent for this vendor
                    </div>
                    {accountResults.recent.map((acct) => (
                      <AccountRow
                        key={acct.id}
                        account={acct}
                        isSelected={selectedAccount?.id === acct.id}
                        onSelect={() => {
                          setSelectedAccount(acct);
                          setShowAccountDropdown(false);
                          setAccountSearch('');
                        }}
                      />
                    ))}
                  </>
                )}

                {/* All matching accounts */}
                {accountResults.accounts.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-2xs text-slate-500 uppercase tracking-wider font-semibold bg-slate-800/80 sticky top-0">
                      All accounts
                    </div>
                    {accountResults.accounts.map((acct) => (
                      <AccountRow
                        key={acct.id}
                        account={acct}
                        isSelected={selectedAccount?.id === acct.id}
                        onSelect={() => {
                          setSelectedAccount(acct);
                          setShowAccountDropdown(false);
                          setAccountSearch('');
                        }}
                      />
                    ))}
                  </>
                )}

                {accountResults.recent.length === 0 && accountResults.accounts.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-600 text-center">No accounts found</div>
                )}
              </div>
            )}
          </div>

          {/* Job / Project */}
          <div className="job-search-container">
            <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
              <Briefcase size={12} className="inline mr-1 -mt-0.5" />
              Job / Project
              {jobRequired && <span className="text-red-400 ml-1">*</span>}
              {!jobRequired && <span className="text-slate-600 ml-1">(optional)</span>}
            </label>

            {/* Selected job display */}
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
                  >
                    <X size={12} />
                  </button>
                  <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400" />
                </div>
              </button>
            )}

            {/* Search input */}
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

            {/* Job dropdown */}
            {showJobDropdown && effectiveLocationId && jobResults && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded-md bg-slate-800 border border-slate-700 shadow-xl">
                {jobResults.length > 0 ? (
                  jobResults.map((job) => (
                    <button
                      key={job.id}
                      onClick={() => {
                        setSelectedJob(job);
                        setShowJobDropdown(false);
                        setJobSearch('');
                      }}
                      className={clsx(
                        'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                        selectedJob?.id === job.id
                          ? 'bg-brand-500/10 text-brand-400'
                          : 'text-slate-300 hover:bg-white/[0.04]'
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

            {/* Validation message */}
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
            disabled={!selectedAccount || isSaving || isAlreadyPosted || jobMissing}
            className={clsx(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
              !selectedAccount || isAlreadyPosted || jobMissing
                ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            )}
          >
            {isSaving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
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
        isSelected
          ? 'bg-brand-500/10 text-brand-400'
          : 'text-slate-300 hover:bg-white/[0.04]'
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
