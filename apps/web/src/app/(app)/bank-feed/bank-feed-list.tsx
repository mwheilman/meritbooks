'use client';

/**
 * The bank-feed review queue (S3 grammar): kit `.tbl.tbl-q` with a sticky header inside
 * its own scroller, the cursor (white + Electric frame) distinct from the selection
 * (Sky), a kit bulk bar for batch approve, and the Midnight key bar. Keyboard lives in
 * BankFeedContent's handler (j/k/a/e/f/Space/Esc) — this table binds no keys itself.
 */

import { useRef, useEffect, useState, useCallback, type ReactNode } from 'react';
import { BulkBar, Button, Check, Icon, InlineNotice, Kbd, Keys, Status } from '@meritbooks/merit-ui';
import { ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { ProposedChip } from '@/components/brand';
import { formatMoney } from '@meritbooks/shared';
import type { BankFeedRow } from '@meritbooks/shared';
import type { SortField, SortDir } from './bank-feed-content';
import { type ConfidenceBand, selectionTotals } from './bank-feed-refine';
import type { SplitSummary } from '@/lib/bank/splits/types';
import { SplitTag } from './split-grid';
import { AccountPickerPopover, JobPickerPopover } from './bank-feed-pickers';
import styles from './bank-feed.module.css';

interface BankFeedListProps {
  transactions: BankFeedRow[];
  isLoading: boolean;
  error: string | null;
  onApprove: (txn: BankFeedRow) => Promise<void>;
  isApproving: boolean;
  onBatchApprove: (txnIds: string[]) => Promise<void>;
  onFlag: (txn: BankFeedRow) => void;
  onInlineUpdate: (txnId: string, updates: { final_account_id?: string; final_job_id?: string | null }) => Promise<void>;
  focusedIndex: number;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onSelectByBand: (band: ConfidenceBand) => void;
  onClearSelection: () => void;
  onSelectByVendor: (vendorName: string) => void;
  onEdit: (txn: BankFeedRow) => void;
  onExplainConfidence: (txn: BankFeedRow) => void;
  bandCounts: Record<ConfidenceBand, number> & { all: number };
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  selectedLocationId: string | null;
  /** Ids flagged as likely duplicates (detect-only) — surfaces a review badge. */
  duplicateIds?: Set<string>;
  /** Clicking a row moves the keyboard cursor to it. */
  onFocusRow?: (index: number) => void;
  /** Error state "Try again". */
  onRetry?: () => void;
  /** Empty state "Show everything" (resets status, band, vendor and search). */
  onClearFilters?: () => void;
  /** Rendered under the table (the pager). */
  footer?: ReactNode;
}

/** Documented auto-approve ceiling ($10,000) + AI confidence bar (85%). The
 *  vendor-trust leg is confirmed server-side at approve; this is the row-level
 *  "meets the AI bar" hint, deliberately honest about that. */
const AUTO_MAX_CENTS = 1_000_000;
const AUTO_CONF = 0.85;

// --- Match badge: icon + word, never colour alone ---

function MatchBadge({ txn }: { txn: BankFeedRow }) {
  const type = txn.match_type;
  if (!type || type === 'NONE') {
    return (
      <span className="match match--none">
        <Icon name="none" />
        Unmatched
      </span>
    );
  }
  if (type === 'BILL_PAYMENT') {
    return (
      <span className="match">
        <Icon name="bill" />
        {txn.matched_bill?.bill_number ? `Bill ${txn.matched_bill.bill_number}` : 'Matched to a bill'}
      </span>
    );
  }
  if (type === 'RECEIPT') {
    return (
      <span className="match">
        <Icon name="receipt" />
        Receipt matched
      </span>
    );
  }
  if (type === 'VENDOR_PATTERN') {
    return (
      <span className="match">
        <Icon name="check" />
        Vendor match
      </span>
    );
  }
  return <span className="match">{type}</span>;
}

// --- Aging (stale line indicator): pip shape + word ---

function Aging({ date }: { date: string }) {
  const hours = (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
  if (!Number.isFinite(hours) || hours < 24) return null;
  const days = Math.floor(hours / 24);
  return hours >= 48 ? (
    <Status kind="overdue">Waiting {days}d</Status>
  ) : (
    <Status kind="risk">Waiting 1d</Status>
  );
}

// --- Sortable header ---

function SortHeader({ label, field, currentField, currentDir, onSort, numeric, width }: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (f: SortField) => void;
  numeric?: boolean;
  width?: number;
}) {
  const active = field === currentField;
  return (
    <th
      scope="col"
      className={numeric ? 'n' : undefined}
      style={width ? { width } : undefined}
      aria-sort={active ? (currentDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className={[styles.sortBtn, active ? styles.sortOn : ''].filter(Boolean).join(' ')}
        onClick={() => onSort(field)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active ? (currentDir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}

// --- Inline account / job cells (each owns the anchor for its popover) ---

function AccountCell({ txn, isPosted, open, onToggle, onSelect, onEdit }: {
  txn: BankFeedRow;
  isPosted: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect: (accountId: string) => void;
  onEdit: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const account = txn.final_account ?? txn.ai_account;
  const split = (txn as BankFeedRow & { split?: SplitSummary | null }).split ?? null;

  if (split) {
    return (
      <>
        <button
          type="button"
          className={styles.cellBtn}
          onClick={onEdit}
          title={split.status === 'DRAFT' ? 'Saved split — open to edit or approve' : 'Posted as a split — open to view'}
        >
          <span className="l1">
            <SplitTag split={split} />
          </span>
        </button>
        <span className="l2">
          <MatchBadge txn={txn} />
        </span>
      </>
    );
  }
  if (isPosted) {
    return (
      <>
        <span className="l1">
          {account ? (
            <>
              <span className="code">{account.account_number}</span>
              {account.name}
            </>
          ) : (
            <span className={styles.muted}>No account</span>
          )}
        </span>
        <span className="l2">
          <MatchBadge txn={txn} />
        </span>
      </>
    );
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.cellBtn}
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change the GL account"
      >
        <span className="l1">
          {account ? (
            <>
              <span className="code">{account.account_number}</span>
              {account.name}
            </>
          ) : (
            <span className={styles.asks}>Assign an account</span>
          )}
        </span>
      </button>
      <span className="l2">
        <MatchBadge txn={txn} />
      </span>
      {open && (
        <AccountPickerPopover
          open
          anchorRef={ref}
          txn={txn}
          vendorId={txn.ai_vendor?.id}
          onSelect={onSelect}
          onClose={onToggle}
        />
      )}
    </>
  );
}

function JobCell({ txn, isPosted, isCogs, locationId, open, onToggle, onSelect, onClear }: {
  txn: BankFeedRow;
  isPosted: boolean;
  isCogs: boolean;
  locationId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (jobId: string) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const job = txn.final_job;
  if (isPosted) {
    return (
      <span className="l1">
        {job ? (
          <>
            <span className="code">{job.job_number}</span>
            {job.name}
          </>
        ) : (
          <span className={styles.muted}>No job</span>
        )}
      </span>
    );
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.cellBtn}
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={isCogs ? 'Cost of goods — a job is required' : 'Assign a job (optional)'}
      >
        <span className="l1">
          {job ? (
            <>
              <span className="code">{job.job_number}</span>
              {job.name}
            </>
          ) : isCogs ? (
            <span className={styles.need}>Job required</span>
          ) : (
            <span className={styles.muted}>Add a job</span>
          )}
        </span>
        {!job && isCogs && <span className="l2">Cost of goods</span>}
      </button>
      {open && (
        <JobPickerPopover
          open
          anchorRef={ref}
          txn={txn}
          locationId={locationId}
          onSelect={onSelect}
          onClear={onClear}
          onClose={onToggle}
        />
      )}
    </>
  );
}

// === MAIN LIST ===

export function BankFeedList({
  transactions,
  isLoading,
  error,
  onApprove,
  isApproving,
  onBatchApprove,
  onFlag,
  onInlineUpdate,
  focusedIndex,
  selected,
  onToggleSelect,
  onToggleAll,
  onSelectByBand,
  onClearSelection,
  onSelectByVendor,
  onEdit,
  onExplainConfidence,
  bandCounts,
  sortField,
  sortDir,
  onSort,
  selectedLocationId,
  duplicateIds,
  onFocusRow,
  onRetry,
  onClearFilters,
  footer,
}: BankFeedListProps) {
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [editingAccountTxnId, setEditingAccountTxnId] = useState<string | null>(null);
  const [editingJobTxnId, setEditingJobTxnId] = useState<string | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  // Auto-scroll focused row into view
  useEffect(() => {
    if (focusedIndex >= 0) {
      const row = rowRefs.current.get(focusedIndex);
      row?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  async function handleApproveClick(txn: BankFeedRow) {
    setApprovingId(txn.id);
    await onApprove(txn);
    setApprovingId(null);
  }

  const handleAccountSelect = useCallback(async (txnId: string, accountId: string) => {
    setEditingAccountTxnId(null);
    await onInlineUpdate(txnId, { final_account_id: accountId });
  }, [onInlineUpdate]);

  const handleJobSelect = useCallback(async (txnId: string, jobId: string) => {
    setEditingJobTxnId(null);
    await onInlineUpdate(txnId, { final_job_id: jobId });
  }, [onInlineUpdate]);

  const handleJobClear = useCallback(async (txnId: string) => {
    setEditingJobTxnId(null);
    await onInlineUpdate(txnId, { final_job_id: null });
  }, [onInlineUpdate]);

  if (isLoading) {
    return (
      <div className={styles.notice}>
        <TableSkeleton rows={8} cols={9} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.notice}>
        <InlineNotice tone="neg" title="The bank feed didn't load.">
          {error}{' '}
          {onRetry && (
            <button type="button" className="link" onClick={onRetry}>
              Try again
            </button>
          )}
        </InlineNotice>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className={styles.queue}>
        <EmptyState
          title="Nothing to review here"
          description="No bank lines match this status, band, vendor or search. Show everything, or press Refresh to pull new lines from the bank."
          action={onClearFilters ? { label: 'Show everything', onClick: onClearFilters } : undefined}
        />
      </div>
    );
  }

  const totals = selectionTotals(transactions, selected);
  const allSelected = selected.size === transactions.length && transactions.length > 0;
  const someSelected = !allSelected && transactions.some((t) => selected.has(t.id));
  const bandChips: Array<{ key: ConfidenceBand; label: string }> = [
    { key: 'high', label: '90+' },
    { key: 'medium', label: '70–89' },
    { key: 'low', label: 'Under 70' },
  ];

  return (
    <div className={styles.queue}>
      {totals.count > 0 ? (
        <BulkBar
          count={totals.count}
          summary={[<span key="t" className="tnum">{formatMoney(totals.totalCents)}</span>]}
          onClear={onClearSelection}
        >
          {bandChips.map((b) =>
            bandCounts[b.key] === 0 ? null : (
              <Button
                key={b.key}
                variant="quiet"
                count={bandCounts[b.key]}
                onClick={() => onSelectByBand(b.key)}
                title={`Select only the visible lines with ${b.label} confidence`}
              >
                {b.label}
              </Button>
            ),
          )}
          <Button
            variant="primary"
            icon="check"
            onClick={() => onBatchApprove(Array.from(selected))}
            disabled={isApproving}
            aria-busy={isApproving || undefined}
          >
            {isApproving ? 'Approving…' : `Approve ${totals.count}`}
          </Button>
        </BulkBar>
      ) : (
        <div className={styles.selbar} role="group" aria-label="Select by confidence">
          <span className="eyebrow">Select</span>
          {bandChips.map((b) => {
            const count = bandCounts[b.key];
            if (count === 0) return null;
            return (
              <Button
                key={b.key}
                variant="quiet"
                count={count}
                onClick={() => onSelectByBand(b.key)}
                title={`Select every visible line with ${b.label} confidence`}
              >
                {b.label}
              </Button>
            );
          })}
          <span className="t-cap">Click a vendor name to select all of theirs.</span>
        </div>
      )}

      <div className={styles.scroll}>
        <table className={`tbl tbl-q ${styles.table}`} aria-label="Bank lines to review">
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 120 }} />
            <col />
            <col style={{ width: 104 }} />
            <col style={{ width: 232 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 128 }} />
            <col style={{ width: 128 }} />
            <col style={{ width: 136 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <Check
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={onToggleAll}
                  aria-label="Select all transactions"
                />
              </th>
              <SortHeader label="Date" field="date" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Payee" field="vendor" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Company" field="company" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <th scope="col">Coding · match</th>
              <th scope="col">Job</th>
              <SortHeader label="Conf." field="confidence" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Amount" field="amount" currentField={sortField} currentDir={sortDir} onSort={onSort} numeric />
              <th scope="col"><span className="sr">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((txn, idx) => {
              const vendorLabel = txn.ai_vendor?.display_name ?? txn.ai_vendor?.name ?? null;
              const account = txn.final_account ?? txn.ai_account;
              const job = txn.final_job;
              // A saved split carries its own accounts / jobs (validated server-side).
              const split = (txn as BankFeedRow & { split?: SplitSummary | null }).split ?? null;
              const draftSplit = split?.status === 'DRAFT';
              const isCogs = !draftSplit && (account?.account_type === 'COGS' || (account?.account_number?.startsWith('5') ?? false));
              const isPosted = txn.status === 'POSTED' || txn.status === 'APPROVED';
              const approvable = draftSplit || !!account;
              const isDuplicate = !isPosted && !!duplicateIds?.has(txn.id);
              const isSelected = selected.has(txn.id);
              const isFlagged = txn.status === 'FLAGGED';
              // Row-level "meets the AI bar" hint: confidence + amount only. The
              // trusted-vendor leg is confirmed server-side at approve time.
              const autoEligible =
                !isPosted &&
                (txn.ai_confidence ?? 0) >= AUTO_CONF &&
                Math.abs(txn.amount_cents) <= AUTO_MAX_CENTS &&
                !!account;
              const approveBlockedReason = isPosted
                ? 'Already posted'
                : !approvable
                  ? 'Assign a GL account before approving'
                  : isCogs && !job
                    ? 'Assign a job before approving (cost of goods)'
                    : null;

              return (
                <tr
                  key={txn.id}
                  ref={(el) => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                  className={[
                    'q-row',
                    isSelected && 'is-selected',
                    focusedIndex === idx && 'is-cursor',
                    (isDuplicate || isFlagged) && 'is-attn',
                  ].filter(Boolean).join(' ')}
                  aria-selected={isSelected}
                  aria-current={focusedIndex === idx ? 'true' : undefined}
                  onClick={(e) => {
                    if (!onFocusRow) return;
                    const t = e.target as HTMLElement;
                    if (t.closest('a,button,input,select,textarea,label')) return;
                    onFocusRow(idx);
                  }}
                >
                  {/* Select */}
                  <td>
                    <Check
                      checked={isSelected}
                      onChange={() => onToggleSelect(txn.id)}
                      aria-label={`Select ${txn.description}, ${formatMoney(txn.amount_cents)}`}
                    />
                  </td>

                  {/* Date + aging */}
                  <td>
                    <span className="l1 tnum">{txn.transaction_date}</span>
                    <span className="l2">
                      {isPosted ? 'Posted' : isFlagged ? 'Flagged' : <Aging date={txn.transaction_date} />}
                    </span>
                  </td>

                  {/* Payee + description (+ duplicate) */}
                  <td>
                    <span className="l1">
                      {vendorLabel ? (
                        <button
                          type="button"
                          className={styles.vend}
                          onClick={() => onSelectByVendor(vendorLabel)}
                          title={`Select every ${vendorLabel} line`}
                        >
                          {vendorLabel}
                        </button>
                      ) : (
                        txn.description
                      )}
                    </span>
                    <span className={`l2 ${styles.l2Row}`}>
                      {isDuplicate && (
                        <span
                          className="match match--partial"
                          title="Same description and amount as another recent line — review before approving"
                        >
                          <Icon name="none" />
                          Possible duplicate
                        </span>
                      )}
                      <span className="mb-trunc">{vendorLabel ? txn.description : 'No vendor yet'}</span>
                    </span>
                  </td>

                  {/* Company */}
                  <td title={txn.location?.name}>
                    {txn.location ? (
                      <>
                        <span className="l1 tnum">{txn.location.short_code}</span>
                        <span className="l2">{txn.location.name}</span>
                      </>
                    ) : (
                      <span className={`l1 ${styles.muted}`}>—</span>
                    )}
                  </td>

                  {/* GL account (inline editable) + match */}
                  <td>
                    <AccountCell
                      txn={txn}
                      isPosted={isPosted}
                      open={editingAccountTxnId === txn.id}
                      onToggle={() => setEditingAccountTxnId(editingAccountTxnId === txn.id ? null : txn.id)}
                      onSelect={(accountId) => handleAccountSelect(txn.id, accountId)}
                      onEdit={() => onEdit(txn)}
                    />
                  </td>

                  {/* Job (inline editable) */}
                  <td>
                    <JobCell
                      txn={txn}
                      isPosted={isPosted}
                      isCogs={isCogs}
                      locationId={selectedLocationId}
                      open={editingJobTxnId === txn.id}
                      onToggle={() => setEditingJobTxnId(editingJobTxnId === txn.id ? null : txn.id)}
                      onSelect={(jobId) => handleJobSelect(txn.id, jobId)}
                      onClear={() => handleJobClear(txn.id)}
                    />
                  </td>

                  {/* Confidence — the meter opens the explainer */}
                  <td>
                    <div className={styles.confCell}>
                      {txn.ai_confidence != null ? (
                        <button
                          type="button"
                          className={styles.confBtn}
                          onClick={() => onExplainConfidence(txn)}
                          title="Why this confidence? Vendor, amount and date breakdown"
                          aria-label={`Explain the confidence score for ${txn.description}`}
                        >
                          <ConfidenceBar value={txn.ai_confidence} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`${styles.confBtn} t-cap`}
                          onClick={() => onExplainConfidence(txn)}
                          aria-label={`Explain the confidence score for ${txn.description}`}
                        >
                          Not scored
                        </button>
                      )}
                      {autoEligible && (
                        <span title="Meets the AI auto-approve bar (confidence ≥ 85% and amount ≤ $10,000). Vendor trust is confirmed on approve — the engine posts the entry.">
                          <ProposedChip showPercent={false} label="Auto-eligible" tone="emerald" />
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Amount */}
                  <td className="n">{formatMoney(txn.amount_cents)}</td>

                  {/* Actions */}
                  <td>
                    <span className="mb-row-acts">
                      <Button
                        variant="quiet"
                        iconOnly
                        icon="check"
                        onClick={() => handleApproveClick(txn)}
                        disabled={!!approveBlockedReason || approvingId === txn.id}
                        aria-busy={approvingId === txn.id || undefined}
                        title={approveBlockedReason ?? (approvingId === txn.id ? 'Approving…' : 'Approve (A)')}
                        aria-label={approveBlockedReason ?? 'Approve transaction'}
                      />
                      <Button
                        variant="quiet"
                        iconOnly
                        icon="sliders"
                        onClick={() => onEdit(txn)}
                        title="Edit in the panel (E)"
                        aria-label="Edit transaction"
                      />
                      <Button
                        variant="quiet"
                        iconOnly
                        icon="flag"
                        onClick={() => onFlag(txn)}
                        disabled={isPosted || isFlagged}
                        title={isFlagged ? 'Already flagged' : 'Flag for review (F)'}
                        aria-label="Flag transaction for review"
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {footer && <div className={styles.foot}>{footer}</div>}

      <div className={`keybar ${styles.keybar}`}>
        <Keys chord="j k">move</Keys>
        <Keys chord="a">approve</Keys>
        <Keys chord="e">edit</Keys>
        <Keys chord="f">flag</Keys>
        <span className="keys"><Kbd>Space</Kbd> select</span>
        <Keys chord="escape">clear</Keys>
        <span className="sp" />
        {totals.count > 0 && <span className="tnum">{totals.count} selected</span>}
        {totals.count === 0 && <span>Nothing posts until you approve it</span>}
      </div>
    </div>
  );
}
