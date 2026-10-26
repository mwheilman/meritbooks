'use client';

import { useState, useCallback } from 'react';
import { Button, Icon, InlineNotice, Pip, Search, Tabs, type PipKind } from '@meritbooks/merit-ui';
import { ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { CreditCardDrawer, type CCLike } from './cc-drawer';
import type { ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { FlagDialog, useFlagTransaction } from '../bank-feed/flag-dialog';
import { SplitTag } from '../bank-feed/split-grid';
import type { SplitSummary } from '@/lib/bank/splits/types';
import s from './credit-cards.module.css';

interface CCRow {
  id: string;
  transaction_date: string;
  description: string;
  amount_cents: number;
  status: string;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  location: { id: string; name: string; short_code: string } | null;
  ai_account: { id: string; account_number: string; name: string } | null;
  ai_vendor: { id: string; name: string; display_name: string | null } | null;
  final_account: { id: string; account_number: string; name: string } | null;
  bank_account: { id: string; account_name: string; account_mask: string } | null;
  /** From the receipt chase (migration 181): MISSING = no receipt yet, PENDING = the cardholder has been asked,
   *  NOT_APPLICABLE = a card payment / refund / credit, which never needs a receipt. */
  receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING' | 'NOT_REQUIRED' | 'NOT_APPLICABLE';
  chaseCount: number;
  /** Saved / posted split (FPB-bank-feed-splits). */
  split?: SplitSummary | null;
}

interface CCResponse {
  data: CCRow[];
  counts: Record<string, { count: number; amount_cents: number }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface ApproveResult {
  success: boolean;
  entry_number: string;
  transaction_id: string;
}

const TAB_CONFIG = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'CATEGORIZED', label: 'Categorized' },
  { key: 'FLAGGED', label: 'Flagged' },
] as const;

/** Receipt-chase state as pip shape + word (never colour alone). */
function ReceiptBadge({ status, chaseCount }: { status: string; chaseCount: number }) {
  // Payments, refunds and credits are not purchases — no receipt badge at all.
  if (status === 'NOT_APPLICABLE') {
    return (
      <span className="ink-3" aria-label="No receipt needed for a payment or credit">
        —
      </span>
    );
  }
  let pip: PipKind = 'open';
  let word = 'No receipt';
  if (status === 'MATCHED') {
    pip = 'ready';
    word = 'Matched';
  } else if (status === 'NOT_REQUIRED') {
    pip = 'closed';
    word = 'Not needed';
  } else if (status === 'PENDING') {
    // Four or more asks is overdue; fewer is at risk.
    pip = chaseCount >= 4 ? 'overdue' : 'risk';
    word = `Asked ${chaseCount}×`;
  }
  return (
    <span className="mb-sev">
      <Pip kind={pip} />
      <span className="tnum">{word}</span>
    </span>
  );
}

export function CreditCardFeed() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  // Company scope is owned by the header picker + <CompanyScopeGuard> (this page
  // is behind the guard, so a specific company is always active). Derive the
  // location from the shared active-company context instead of a redundant
  // in-page selector; useQuery also auto-attaches it as `location_id`.
  const { activeCompanyId } = useActiveCompany();
  const locationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error, refetch } = useQuery<CCResponse>(
    '/api/credit-cards',
    Object.keys(params).length > 0 ? params : undefined,
  );
  const [selectedTxn, setSelectedTxn] = useState<CCLike | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<CCLike>();

  const { mutate: approveTxn } = useMutation<ApproveBankTransactionInput, ApproveResult>(
    '/api/bank-feed/approve'
  );

  const handleApprove = useCallback(async (txn: CCRow) => {
    const account = txn.final_account ?? txn.ai_account;
    // A saved draft split posts itself (the approve route reads it).
    if (!account && txn.split?.status !== 'DRAFT') {
      addToast('error', 'No GL account assigned');
      return;
    }
    setApprovingId(txn.id);
    const result = await approveTxn({
      transaction_id: txn.id,
      account_id: account?.id,
      vendor_id: txn.ai_vendor?.id ?? undefined,
    });
    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      refetch();
    } else {
      addToast('error', 'Failed to approve');
    }
    setApprovingId(null);
  }, [approveTxn, refetch]);

  // Flag — same action/route as the Bank Feed (card lines are bank_transactions).
  const [flaggingTxn, setFlaggingTxn] = useState<CCRow | null>(null);
  const { flag, isFlagging } = useFlagTransaction();
  const handleFlagSubmit = useCallback(async (reason: string) => {
    if (!flaggingTxn) return;
    const res = await flag(flaggingTxn.id, reason);
    if (res.ok) {
      addToast('success', 'Transaction flagged for review');
      setFlaggingTxn(null);
      refetch();
    } else {
      addToast('error', res.error);
    }
  }, [flaggingTxn, flag, refetch]);

  const transactions = data?.data ?? [];
  const counts = data?.counts ?? null;
  const peekAccount = peek ? (peek.item.final_account ?? peek.item.ai_account) : null;

  return (
    <div className={s.feed}>
      {/* Status tabs — count and amount per status */}
      <Tabs
        aria-label="Card transactions by status"
        value={activeTab}
        onChange={setActiveTab}
        items={TAB_CONFIG.map((tab) => {
          const stats = counts?.[tab.key] ?? null;
          return {
            value: tab.key as string,
            label: tab.label,
            count: stats ? `${stats.count} · ${formatMoney(stats.amount_cents, { compact: true })}` : '—',
          };
        })}
      />

      {/* Search */}
      <div className="mb-toolbar">
        <Search
          className={s.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by vendor or description"
          aria-label="Search credit card transactions by vendor or description"
        />
        <span className="sp" />
        {data && !isLoading && (
          <span className="t-cap tnum">
            {data.pagination.total} transaction{data.pagination.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={6} cols={8} />
      ) : error ? (
        <div className={`surface ${s.state}`}>
          <InlineNotice tone="neg" title="Card transactions didn’t load.">
            {error}{' '}
            <Button variant="quiet" onClick={() => refetch()}>
              Try again
            </Button>
          </InlineNotice>
        </div>
      ) : transactions.length === 0 ? (
        <EmptyState
          title="No card transactions here"
          description={
            debouncedSearch || activeTab !== 'all'
              ? 'Nothing matches this status or search. Try another tab or clear the search.'
              : 'Card charges appear here once a card account syncs or a card statement is imported.'
          }
          action={debouncedSearch || activeTab !== 'all' ? { label: 'Show all', onClick: () => { setSearch(''); setActiveTab('all'); } } : undefined}
        />
      ) : (
        <div className={`mb-scroll-x ${s.tableWrap}`}>
          <table className="tbl tbl-q" aria-label="Card transactions" style={{ minWidth: 1040 }}>
            <colgroup>
              <col style={{ width: 120 }} />
              <col />
              <col style={{ width: 168 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 216 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 112 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Card</th>
                <th>Company</th>
                <th>GL account</th>
                <th>Confidence</th>
                <th className="n">Amount</th>
                <th>Receipt</th>
                <th><span className="sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => {
                const account = txn.final_account ?? txn.ai_account;
                const vendor = txn.ai_vendor?.display_name ?? txn.ai_vendor?.name ?? null;
                const isPosted = txn.status === 'POSTED' || txn.status === 'APPROVED';
                const cantApprove = (!account && txn.split?.status !== 'DRAFT') || isPosted;
                return (
                  <tr
                    key={txn.id}
                    {...rowHandlers(txn as unknown as CCLike)}
                    onClick={() => setSelectedTxn(txn as unknown as CCLike)}
                    className={`q-row ${s.row}${selectedTxn?.id === txn.id ? ' is-cursor' : ''}`}
                    aria-current={selectedTxn?.id === txn.id ? 'true' : undefined}
                  >
                    <td className="tnum ink-2">{txn.transaction_date}</td>
                    <td>
                      <span className="l1" title={txn.description}>{txn.description}</span>
                      {vendor && <span className="l2">{vendor}</span>}
                    </td>
                    <td>
                      {txn.bank_account ? (
                        <>
                          <span className="l1">{txn.bank_account.account_name}</span>
                          <span className="l2 tnum">••{txn.bank_account.account_mask}</span>
                        </>
                      ) : (
                        <span className="ink-3">—</span>
                      )}
                    </td>
                    <td>
                      {txn.location ? (
                        <span className="code" title={txn.location.name}>{txn.location.short_code}</span>
                      ) : (
                        <span className="ink-3">—</span>
                      )}
                    </td>
                    <td>
                      {txn.split ? (
                        <SplitTag split={txn.split} />
                      ) : account ? (
                        <span className="l1" title={`${account.account_number} · ${account.name}`}>
                          <span className="code">{account.account_number}</span>
                          {account.name}
                        </span>
                      ) : (
                        <span className="mb-sev">
                          <Pip kind="soft" />
                          Uncategorized
                        </span>
                      )}
                    </td>
                    <td>{txn.ai_confidence != null ? <ConfidenceBar value={txn.ai_confidence} /> : <span className="ink-3">—</span>}</td>
                    <td className="n tnum">{formatMoney(Math.abs(txn.amount_cents))}</td>
                    <td>
                      <ReceiptBadge status={txn.receiptStatus} chaseCount={txn.chaseCount} />
                    </td>
                    <td className="n">
                      <span className="mb-row-acts">
                        <Button
                          variant="quiet"
                          iconOnly
                          icon="check"
                          onClick={(e) => { e.stopPropagation(); handleApprove(txn); }}
                          disabled={cantApprove || approvingId === txn.id}
                          aria-busy={approvingId === txn.id || undefined}
                          title={isPosted ? 'Already posted' : !account && txn.split?.status !== 'DRAFT' ? 'Pick a GL account first' : 'Approve'}
                          aria-label={`Approve transaction ${txn.description}`}
                        />
                        <Button
                          variant="quiet"
                          iconOnly
                          icon="flag"
                          onClick={(e) => { e.stopPropagation(); setFlaggingTxn(txn); }}
                          disabled={isPosted || txn.status === 'FLAGGED'}
                          title={txn.status === 'FLAGGED' ? 'Already flagged' : 'Flag'}
                          aria-label={`Flag transaction ${txn.description}`}
                        />
                        <Icon name="right" className={s.chev} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null} visible={!!peek} cardHandlers={cardHandlers}
        onOpen={peek ? () => { const t = peek.item; close(); setSelectedTxn(t); } : undefined}
      >
        {peek && (
          <div className={s.peek}>
            <div className="t-head mb-trunc">{peek.item.description}</div>
            <div className={s.peekRow}>
              <span className="t-cap tnum">{peek.item.transaction_date}</span>
              <span className="tnum">{formatMoney(Math.abs(peek.item.amount_cents))}</span>
            </div>
            <div className="t-cap mb-trunc">
              {peekAccount ? `${peekAccount.account_number} · ${peekAccount.name}` : 'Uncategorized'}
            </div>
          </div>
        )}
      </HoverPeekCard>

      <CreditCardDrawer
        txn={selectedTxn}
        onClose={() => setSelectedTxn(null)}
        onChanged={() => { setSelectedTxn(null); refetch(); }}
      />

      {flaggingTxn && (
        <FlagDialog
          transaction={flaggingTxn}
          isLoading={isFlagging}
          onSubmit={handleFlagSubmit}
          onClose={() => setFlaggingTxn(null)}
        />
      )}
    </div>
  );
}
