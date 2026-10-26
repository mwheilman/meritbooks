'use client';
import { useEffect, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { ConfidenceBar, StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';
import { Button } from '@meritbooks/merit-ui';
import type { SplitSummary } from '@/lib/bank/splits/types';
import { SplitGrid, SplitTag } from '../bank-feed/split-grid';

export interface CCLike {
  id: string; transaction_date: string; description: string; amount_cents: number; status: string;
  ai_confidence: number | null; ai_reasoning: string | null;
  location: { id: string; name: string; short_code: string } | null;
  ai_account: { id: string; account_number: string; name: string } | null;
  final_account: { id: string; account_number: string; name: string } | null;
  ai_vendor: { id: string; name: string; display_name: string | null } | null;
  bank_account: { id: string; account_name: string; account_mask: string } | null;
  receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING'; chaseCount: number;
  /** Saved / posted split (FPB-bank-feed-splits). */
  split?: SplitSummary | null;
}

/** Receipt-chase state in plain words (the raw enum never reaches the screen). */
const RECEIPT_WORD: Record<string, string> = {
  MATCHED: 'Matched',
  MISSING: 'No receipt yet',
  PENDING: 'Cardholder asked',
  NOT_REQUIRED: 'Not needed',
  NOT_APPLICABLE: 'Not needed (payment or credit)',
};

/**
 * Card-line drawer. "Split this charge" opens the same split grid as the bank feed
 * (card lines are bank_transactions; the cash side is the card's liability account),
 * so a shared-card charge can be split across accounts, jobs and companies.
 */
export function CreditCardDrawer({ txn, onClose, onChanged }: { txn: CCLike | null; onClose: () => void; onChanged?: () => void }) {
  const account = txn ? (txn.final_account ?? txn.ai_account) : null;
  const vendor = txn?.ai_vendor?.display_name ?? txn?.ai_vendor?.name ?? null;
  const [splitting, setSplitting] = useState(false);
  useEffect(() => {
    setSplitting(!!txn?.split);
  }, [txn?.id, txn?.split]);

  return (
    <DetailDrawer
      open={!!txn} onClose={onClose} width={splitting ? 'lg' : 'md'}
      title={txn?.description ?? 'Transaction'}
      subtitle={txn ? `${txn.transaction_date}${txn.location ? ` · ${txn.location.short_code}` : ''}` : null}
      headerRight={txn ? <StatusBadge status={txn.status} /> : undefined}
    >
      {txn && (
        <>
          <DetailSection title="Transaction">
            <DetailField label="Amount" value={formatMoney(Math.abs(txn.amount_cents))} mono />
            <DetailField label="Date" value={txn.transaction_date} mono />
            {vendor && <DetailField label="Vendor" value={vendor} />}
            <DetailField label="Card" value={txn.bank_account ? `${txn.bank_account.account_name} ••${txn.bank_account.account_mask}` : '—'} />
            <DetailField label="Company" value={txn.location?.name ?? '—'} />
            <DetailField
              label="Receipt"
              value={`${RECEIPT_WORD[txn.receiptStatus] ?? txn.receiptStatus}${txn.receiptStatus === 'PENDING' && txn.chaseCount > 0 ? ` · ${txn.chaseCount}×` : ''}`}
            />
          </DetailSection>
          <DetailSection title="Categorization">
            {txn.split ? (
              <DetailField label="GL account" value={<SplitTag split={txn.split} />} />
            ) : (
              <DetailField label="GL account" value={account ? `${account.account_number} · ${account.name}` : 'Uncategorized'} />
            )}
            <DetailField label="AI confidence" value={txn.ai_confidence != null ? <ConfidenceBar value={txn.ai_confidence} /> : '—'} />
            {txn.ai_reasoning && <DetailField label="AI reasoning" value={txn.ai_reasoning} />}
          </DetailSection>
          <DetailSection title="Split">
            {splitting ? (
              <SplitGrid
                transaction={{
                  id: txn.id,
                  amount_cents: txn.amount_cents,
                  status: txn.status,
                  location_id: txn.location?.id ?? null,
                  vendor_id: txn.ai_vendor?.id ?? null,
                  vendor_name: vendor,
                  description: txn.description,
                }}
                seedAccount={account}
                onUnsplit={() => setSplitting(false)}
                onDone={() => onChanged?.()}
              />
            ) : txn.status === 'POSTED' || txn.status === 'APPROVED' ? (
              <p className="t-cap">Posted as one account. Reverse it from the Bank Feed to split it.</p>
            ) : (
              <Button onClick={() => setSplitting(true)}>Split this charge</Button>
            )}
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
