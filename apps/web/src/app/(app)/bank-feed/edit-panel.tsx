'use client';

import { useState, useEffect, useRef, useCallback, useMemo, useId, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Button,
  ConfirmDialog,
  Eyebrow,
  Field,
  Icon,
  Input,
  NotePanel,
  Panel,
  PanelSection,
  Search,
  Select,
  Tag,
  Textarea,
  useFocusTrap,
} from '@meritbooks/merit-ui';
import { useQuery, useDebounce, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { ExplainPanel } from '@/components/explain-panel';
import type { BankFeedRow, JobSearchResult } from '@meritbooks/shared';
import type { ApproveBankTransactionInput } from '@/lib/validations/transactions';
import type { SplitSummary } from '@/lib/bank/splits/types';
import { SplitGrid } from './split-grid';
import { AutoApproveSection, MatchScoreSection, type AutoApproveInsight, type MatchBreakdownInsight } from './insight-parts';
import s from './bank-feed-panels.module.css';

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

/** M14 learning memory: how this vendor is usually coded (derived from history). */
interface VendorMemorySuggestion {
  accountId: string;
  accountNumber: string | null;
  accountName: string | null;
  accountType: string | null;
  count: number;
  total: number;
  share: number;
  confidence: number;
  lastUsedAt: string | null;
}

interface VendorMemoryResponse {
  vendorId: string | null;
  vendorName: string | null;
  total: number;
  suggestions: VendorMemorySuggestion[];
  top: VendorMemorySuggestion | null;
}

/** Auto-match insight (from /api/bank-feed/[id]/insight). */
interface InsightResponse {
  autoApprove: AutoApproveInsight;
  match: MatchBreakdownInsight;
  topAccounts: Array<{
    accountId: string;
    accountNumber: string | null;
    accountName: string | null;
    count: number;
    total: number;
    share: number;
  }>;
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

/**
 * The edit side panel (board S3 grammar): head with payee + amount, the AI's
 * suggestion as a note, then account → dimensions → job → notes, and a sticky
 * foot with the one primary verb. It slides over the list on a scrim and is
 * rendered in place (no portal) so the split grid it mounts keeps the page's styles.
 *
 * Esc closes the innermost thing first: an open picker list, then (via the kit
 * dialog) the reversal confirmation, then the panel.
 */
export function EditPanel({ transaction, locationId, onClose, onSave }: EditPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, true);
  // Split mode (FPB-bank-feed-splits): opens straight into the grid when the line
  // already carries a draft or posted split.
  const existingSplit = (transaction as BankFeedRow & { split?: SplitSummary | null }).split ?? null;
  const [splitMode, setSplitMode] = useState<boolean>(!!existingSplit);
  const [reverseOpen, setReverseOpen] = useState(false);
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
  const [selectedClass, setSelectedClass] = useState<ClassOption | null>(null);

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

  // M14 learning: what account this vendor is usually coded to, derived live from
  // the tenant's own approved history. Powers the one-click "you usually code…"
  // hint below. Amount-aware so it biases toward similar-sized past charges.
  const vendorMemoryParams: Record<string, string> = {
    amount_cents: String(Math.abs(transaction.amount_cents)),
  };
  if (transaction.ai_vendor?.id) vendorMemoryParams.vendor_id = transaction.ai_vendor.id;
  const { data: vendorMemory, isLoading: memoryLoading } = useQuery<VendorMemoryResponse>(
    '/api/learning/vendor-memory',
    vendorMemoryParams,
    { enabled: !!transaction.ai_vendor?.id }
  );
  // Only surface a hint once there is enough history to be worth trusting (>=2).
  const memoryTop =
    vendorMemory?.top && vendorMemory.top.count >= 2 ? vendorMemory.top : null;
  // Top-N (up to 3) accounts this vendor is usually coded to.
  const topAccounts = (vendorMemory?.suggestions ?? []).filter((x) => x.count >= 1).slice(0, 3);

  // Auto-match insight: the "why did/didn't this auto-approve" + composite match
  // breakdown, computed server-side against the org's real policy. Read-only.
  const { data: insight } = useQuery<InsightResponse>(
    `/api/bank-feed/${transaction.id}/insight`,
  );

  const applyMemory = useCallback((m: VendorMemorySuggestion) => {
    setSelectedAccount({
      id: m.accountId,
      account_number: m.accountNumber ?? '',
      name: m.accountName ?? '',
      account_type: m.accountType ?? undefined,
    });
    setShowAccountDropdown(false);
    setAccountSearch('');
  }, []);

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

  // Approve via direct fetch so we can surface the server's actual error
  // message (e.g. "No fiscal period found for date …") instead of a generic
  // toast. The useMutation hook swallows the message behind a null return.
  const [isSaving, setIsSaving] = useState(false);

  // Esc: an open picker list closes first, then the panel. The reversal dialog
  // and the split grid handle their own Esc (they mark it defaultPrevented).
  const anyListOpen = showAccountDropdown || showJobDropdown;
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || reverseOpen) return;
      if (anyListOpen) {
        setShowAccountDropdown(false);
        setShowJobDropdown(false);
        return;
      }
      onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, reverseOpen, anyListOpen]);

  // Close the inline picker lists on a click outside their containers
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (searchInputRef.current && !searchInputRef.current.closest('.account-search-container')?.contains(t)) {
        setShowAccountDropdown(false);
      }
      if (jobSearchRef.current && !jobSearchRef.current.closest('.job-search-container')?.contains(t)) {
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
    if (deptMissing) {
      addToast('error', `${entity?.name ?? 'This company'} requires a department on every entry`);
      return;
    }
    if (classMissing) {
      addToast('error', `${entity?.name ?? 'This company'} requires a class on every entry`);
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/bank-feed/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transaction.id,
          account_id: selectedAccount.id,
          vendor_id: transaction.ai_vendor?.id ?? undefined,
          job_id: selectedJob?.id ?? undefined,
          department_id: selectedDept?.id ?? undefined,
          class_id: selectedClass?.id ?? undefined,
          vendor_name: vendorName.trim() || undefined,
          notes: notes.trim() || undefined,
        } satisfies ApproveBankTransactionInput),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.success) {
        addToast('success', `Approved → ${result.entry_number}`);
        onSave();
      } else {
        // Surface the real reason (period, dimension, balance, etc.).
        addToast('error', result?.error ?? 'Failed to approve transaction');
      }
    } catch {
      addToast('error', 'Network error while approving');
    } finally {
      setIsSaving(false);
    }
  }, [selectedAccount, transaction, onSave, selectedJob, selectedDept, selectedClass, jobMissing, deptMissing, classMissing, entity, vendorName, notes]);

  // Reversal-on-edit (Spec Part G; posted-GL immutability, migration 153): voids the
  // posting and returns the line to review — nothing is silently changed. Runs from
  // the kit ConfirmDialog; a thrown error keeps the dialog open with the reason typed.
  const handleReverse = useCallback(async (reason: string) => {
    if (reason.trim().length < 3) {
      addToast('error', 'Say why the posting is being reversed');
      throw new Error('Say why the posting is being reversed.');
    }
    let res: Response;
    try {
      res = await fetch('/api/bank-feed/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transaction.id, reason: reason.trim() }),
      });
    } catch {
      addToast('error', 'Network error while reversing');
      throw new Error('Network error while reversing. Try again.');
    }
    const result = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; voided?: string[] };
    if (res.ok && result.success) {
      addToast('success', `Reversed ${result.voided?.join(', ') ?? ''} — the line is back in review`);
      onSave();
      return;
    }
    const msg = result.error ?? 'Could not reverse the posting';
    addToast('error', msg);
    throw new Error(msg);
  }, [transaction.id, onSave]);

  const isAlreadyPosted = transaction.status === 'POSTED' || transaction.status === 'APPROVED';
  const canSave = !!selectedAccount && !isSaving && !isAlreadyPosted && !blockingMissing;
  const groupedAccounts = useMemo(
    () => groupByType(accountResults?.accounts ?? []),
    [accountResults]
  );

  // ⌘↵ / Ctrl+↵ anywhere in the panel = Save & approve (same guard as the button).
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !splitMode && transaction.status !== 'POSTED' && canSave) {
      e.preventDefault();
      void handleSaveApprove();
    }
  };

  const vendorDisplay = transaction.ai_vendor?.display_name ?? transaction.ai_vendor?.name ?? null;
  const aiPct = transaction.ai_confidence == null ? null : Math.round(transaction.ai_confidence * 100);
  const pickAccount = (acct: AccountOption) => {
    setSelectedAccount(acct);
    setShowAccountDropdown(false);
    setAccountSearch('');
  };

  const head = (
    <div className="panel-head">
      <div className="row row--between">
        <Eyebrow as="span">{['Edit transaction', transaction.transaction_date]}</Eyebrow>
        <Button variant="quiet" iconOnly icon="x" aria-label="Close" onClick={onClose} />
      </div>
      <div className={s.headRow}>
        <h2 className="t-head" id={titleId} title={vendorDisplay ?? transaction.description}>
          {vendorDisplay ?? transaction.description}
        </h2>
        <span className={s.headAmt}>{formatMoney(transaction.amount_cents)}</span>
      </div>
      <div className={s.headMeta}>
        <StatusBadge status={transaction.status} />
        {entity && <span className="t-cap">{entity.name}</span>}
      </div>
      {vendorDisplay && <p className={`t-cap ${s.desc}`}>{transaction.description}</p>}
    </div>
  );

  const foot = (
    <div className={s.foot}>
      {transaction.status === 'POSTED' ? (
        <Button
          variant="danger"
          onClick={() => setReverseOpen(true)}
          title="Voids the posted journal entries and returns this line to review"
        >
          Reverse &amp; edit
        </Button>
      ) : splitMode ? (
        <span className="t-cap">Approve from the split above</span>
      ) : (
        <Button
          variant="primary"
          icon={isSaving ? undefined : 'check'}
          onClick={() => void handleSaveApprove()}
          disabled={!canSave}
          aria-busy={isSaving || undefined}
          chord={isAlreadyPosted ? undefined : 'mod+enter'}
        >
          {isAlreadyPosted ? 'Already posted' : isSaving ? 'Approving…' : 'Save & approve'}
        </Button>
      )}
      <span className="sp" />
      <Button variant="quiet" onClick={onClose} chord="escape">
        Cancel
      </Button>
    </div>
  );

  return (
    <div
      className="scrim scrim--fixed mb-side-scrim"
      onMouseDown={(e) => {
        // A click on the scrim (outside the panel) closes it, as before.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-hotkeys="off"
        className={s.drawer}
        style={{ width: splitMode ? 780 : 480 }}
        onKeyDown={onPanelKeyDown}
      >
        <Panel head={head} foot={foot} aria-label="Edit transaction">
          {/* The AI's suggestion, as a note: account, confidence, reasoning. */}
          {(aiPct != null || transaction.ai_reasoning) && (
            <PanelSection>
              <NotePanel
                tag="AI suggestion"
                confidence={aiPct ?? undefined}
                title={
                  transaction.ai_account ? (
                    <>
                      <span className="code">{transaction.ai_account.account_number}</span>
                      {transaction.ai_account.name}
                    </>
                  ) : (
                    'No account suggested yet'
                  )
                }
                basis={['Nothing posts until you approve']}
              >
                {transaction.ai_reasoning}
              </NotePanel>
            </PanelSection>
          )}

          {/* Auto-approve eligibility — confidence ≥ threshold AND amount ≤ cap AND trusted vendor */}
          {insight?.autoApprove && <AutoApproveSection insight={insight.autoApprove} />}

          {/* Composite match breakdown — Vendor 40% + Amount 40% + Date 20% */}
          {insight?.match?.breakdown && <MatchScoreSection match={insight.match} />}

          {/* Ledger-grounded "why was this categorized/posted this way" */}
          <PanelSection>
            <ExplainPanel kind="BANK_TRANSACTION" id={transaction.id} />
          </PanelSection>

          {/* Vendor name */}
          <PanelSection>
            <Field label="Vendor">
              <Input
                type="text"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="Vendor name"
                aria-label="Vendor name"
              />
            </Field>
          </PanelSection>

          {/* Split toggle (FPB-bank-feed-splits) — card lines use the same grid. */}
          {!splitMode && transaction.status !== 'POSTED' && (
            <PanelSection>
              <div className={s.splitRow}>
                <span className="t-cap">One account for the whole amount, or split it across accounts, companies and jobs.</span>
                <Button icon="layers" onClick={() => setSplitMode(true)}>
                  Split
                </Button>
              </div>
            </PanelSection>
          )}

          {splitMode ? (
            <PanelSection title="Split">
              <SplitGrid
                transaction={{
                  id: transaction.id,
                  amount_cents: transaction.amount_cents,
                  status: transaction.status,
                  location_id: effectiveLocationId,
                  vendor_id: transaction.ai_vendor?.id ?? null,
                  vendor_name: transaction.ai_vendor?.display_name ?? transaction.ai_vendor?.name ?? null,
                  description: transaction.description,
                }}
                seedAccount={selectedAccount ?? null}
                vendorName={vendorName}
                notes={notes}
                onUnsplit={() => setSplitMode(false)}
                onDone={() => onSave()}
              />
            </PanelSection>
          ) : (
            <>
              {/* GL Account (grouped by type) */}
              <PanelSection title="GL account">
                <div className="account-search-container">
                  {/* M14 learning hint: "You usually code {vendor} to {account}". Proposes
                      only — a human still approves. Shown when we have enough history. */}
                  {transaction.ai_vendor?.id && memoryLoading && !memoryTop && (
                    <div className={`wg-loading ${s.memory}`} aria-busy="true">
                      <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
                      <span className="t-cap" role="status">Checking how you usually code this vendor…</span>
                    </div>
                  )}
                  {memoryTop && (
                    <div className={s.memory}>
                      <NotePanel
                        tag="From your history"
                        title={
                          <>
                            You usually code {vendorMemory?.vendorName ?? vendorDisplay ?? 'this vendor'} to{' '}
                            <span className="code">{memoryTop.accountNumber}</span>
                            {memoryTop.accountName}
                          </>
                        }
                        basis={[`${memoryTop.count} of ${memoryTop.total} times`]}
                        actions={
                          selectedAccount?.id === memoryTop.accountId ? (
                            <Tag tone="pos">Applied</Tag>
                          ) : (
                            <Button variant="quiet" icon="check" onClick={() => applyMemory(memoryTop)}>
                              Use this account
                            </Button>
                          )
                        }
                      />
                    </div>
                  )}

                  {/* Top-N GL accounts this vendor is usually coded to (quick picks). */}
                  {topAccounts.length > 1 && (
                    <div className={s.memory}>
                      <span className="t-cap">Most-used accounts for this vendor</span>
                      <div className={s.recents}>
                        {topAccounts.map((m) => (
                          <button
                            key={m.accountId}
                            type="button"
                            className={s.recent}
                            aria-pressed={selectedAccount?.id === m.accountId}
                            onClick={() => applyMemory(m)}
                            title={`${m.count} of ${m.total} past codings`}
                          >
                            <span>
                              <span className="code">{m.accountNumber}</span>
                              {m.accountName}
                            </span>
                            <span className={`${s.recentCt} tnum`}>{Math.round(m.share * 100)}%</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedAccount && !showAccountDropdown && (
                    <div className={s.pickTrigger}>
                      <button
                        type="button"
                        className={s.pickMain}
                        onClick={() => {
                          setShowAccountDropdown(true);
                          setAccountSearch('');
                          setTimeout(() => searchInputRef.current?.focus(), 50);
                        }}
                        aria-label={`GL account ${selectedAccount.account_number} ${selectedAccount.name}. Change`}
                      >
                        <span>
                          <span className="code">{selectedAccount.account_number}</span>
                          {selectedAccount.name}
                        </span>
                        <Icon name="down" />
                      </button>
                    </div>
                  )}

                  {(!selectedAccount || showAccountDropdown) && (
                    <Search
                      ref={searchInputRef}
                      value={accountSearch}
                      onChange={(e) => setAccountSearch(e.target.value)}
                      onFocus={() => setShowAccountDropdown(true)}
                      placeholder="Search by account number or name"
                      aria-label="Search GL accounts"
                      data-autofocus={!selectedAccount ? true : undefined}
                    />
                  )}

                  {showAccountDropdown && accountResults && (
                    <div className={s.pickList}>
                      {accountResults.recent.length > 0 && (
                        <>
                          <div className={`${s.pickGroup} ${s.pickGroupAi}`}>Recent for this vendor</div>
                          {accountResults.recent.map((acct) => (
                            <AccountRow
                              key={acct.id}
                              account={acct}
                              isSelected={selectedAccount?.id === acct.id}
                              onSelect={() => pickAccount(acct)}
                            />
                          ))}
                        </>
                      )}

                      {groupedAccounts.map((group) => (
                        <div key={group.type}>
                          <div className={s.pickGroup}>{TYPE_LABEL[group.type] ?? group.type}</div>
                          {group.rows.map((acct) => (
                            <AccountRow
                              key={acct.id}
                              account={acct}
                              isSelected={selectedAccount?.id === acct.id}
                              onSelect={() => pickAccount(acct)}
                            />
                          ))}
                        </div>
                      ))}

                      {accountResults.recent.length === 0 && groupedAccounts.length === 0 && (
                        <div className={s.pickEmpty}>No accounts match. Try the account number or part of the name.</div>
                      )}
                    </div>
                  )}
                </div>
              </PanelSection>

              <PanelSection title="Dimensions">
                <div className={s.fields}>
                  {/* Department */}
                  <DimensionSelect
                    label="Department"
                    required={requireDept}
                    value={selectedDept?.id ?? ''}
                    emptyHint={departments.length === 0 ? 'No departments for this company' : 'Select a department'}
                    options={departments.map((d) => ({ id: d.id, label: `${d.code} · ${d.name}` }))}
                    onChange={(id) => setSelectedDept(departments.find((d) => d.id === id) ?? null)}
                    missing={deptMissing}
                    missingMsg="This company requires a department on every entry"
                  />

                  {/* Class */}
                  <DimensionSelect
                    label="Class"
                    required={requireClass}
                    value={selectedClass?.id ?? ''}
                    emptyHint={classes.length === 0 ? 'No classes defined' : 'Select a class'}
                    options={classes.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
                    onChange={(id) => setSelectedClass(classes.find((c) => c.id === id) ?? null)}
                    missing={classMissing}
                    missingMsg="This company requires a class on every entry"
                  />

                  {/* Job / Project */}
                  <div className="job-search-container field">
                    <span className="field-label">
                      Job / project
                      {jobRequired ? <span className={s.req} aria-label="required">*</span> : <span className={s.opt}>(optional)</span>}
                    </span>

                    {selectedJob && !showJobDropdown && (
                      <div className={s.pickTrigger}>
                        <button
                          type="button"
                          className={s.pickMain}
                          onClick={() => {
                            setShowJobDropdown(true);
                            setJobSearch('');
                            setTimeout(() => jobSearchRef.current?.focus(), 50);
                          }}
                          aria-label={`Job ${selectedJob.job_number} ${selectedJob.name}. Change`}
                        >
                          <span>
                            <span className="code">{selectedJob.job_number}</span>
                            {selectedJob.name}
                            {selectedJob.customer_name && <span className="ink-3"> ({selectedJob.customer_name})</span>}
                          </span>
                          <Icon name="down" />
                        </button>
                        <Button variant="quiet" iconOnly icon="x" aria-label="Clear job" onClick={() => setSelectedJob(null)} />
                      </div>
                    )}

                    {(!selectedJob || showJobDropdown) && (
                      <Search
                        ref={jobSearchRef}
                        value={jobSearch}
                        onChange={(e) => setJobSearch(e.target.value)}
                        onFocus={() => setShowJobDropdown(true)}
                        placeholder={effectiveLocationId ? 'Search by job number or name' : 'Select a company first'}
                        aria-label="Search jobs"
                        disabled={!effectiveLocationId}
                      />
                    )}

                    {showJobDropdown && effectiveLocationId && jobResults && (
                      <div className={`${s.pickList} ${s.pickListShort}`}>
                        {jobResults.length > 0 ? (
                          jobResults.map((job) => (
                            <button
                              key={job.id}
                              type="button"
                              className={s.pickItem}
                              aria-pressed={selectedJob?.id === job.id}
                              onClick={() => { setSelectedJob(job); setShowJobDropdown(false); setJobSearch(''); }}
                            >
                              <span>
                                <span className="code">{job.job_number}</span>
                                {job.name}
                                {job.customer_name && <span className="ink-3"> ({job.customer_name})</span>}
                              </span>
                              <span className="t-cap">{job.status}</span>
                            </button>
                          ))
                        ) : (
                          <div className={s.pickEmpty}>No jobs match. Try the job number or part of the name.</div>
                        )}
                      </div>
                    )}

                    {jobMissing && (
                      <span className="field-error" role="alert">
                        COGS account — a job is required for cost tracking
                      </span>
                    )}
                  </div>
                </div>
              </PanelSection>
            </>
          )}

          {/* Notes */}
          <PanelSection>
            <Field label="Notes">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add a note about this transaction"
                aria-label="Notes"
                rows={3}
              />
            </Field>
          </PanelSection>
        </Panel>
      </div>

      <ConfirmDialog
        open={reverseOpen}
        onClose={() => setReverseOpen(false)}
        onConfirm={async (reason) => {
          await handleReverse(reason ?? '');
        }}
        title="Reverse this posting?"
        confirmLabel="Reverse posting"
        tone="danger"
        footNote="The journal entries are voided, not deleted."
        reason={{
          label: 'Why reverse?',
          help: 'Required. At least 3 characters. Kept on the audit trail.',
          minLength: 3,
          placeholder: 'e.g. Coded to the wrong account',
        }}
      >
        This voids the posted journal entries and returns the line to review, where you can code it again.
      </ConfirmDialog>
    </div>
  );
}

function AccountRow({ account, isSelected, onSelect }: {
  account: AccountOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={s.pickItem} aria-pressed={isSelected} onClick={onSelect}>
      <span>
        <span className="code">{account.account_number}</span>
        {account.name}
      </span>
      {isSelected && <Icon name="check" label="Selected" />}
    </button>
  );
}

/** Single-select for the Department and Class dimensions (kit native select). */
function DimensionSelect(props: {
  label: string;
  required: boolean;
  value: string;
  emptyHint: string;
  options: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  missing: boolean;
  missingMsg: string;
}) {
  const { label, required, value, emptyHint, options, onChange, missing, missingMsg } = props;
  return (
    <Field
      label={
        <>
          {label}
          {required ? <span className={s.req} aria-label="required">*</span> : <span className={s.opt}>(optional)</span>}
        </>
      }
      error={missing ? missingMsg : undefined}
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={options.length === 0}>
        <option value="">{emptyHint}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
