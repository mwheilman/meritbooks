'use client';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';

export interface CCLike {
  id: string; transaction_date: string; description: string; amount_cents: number; status: string;
  ai_confidence: number | null; ai_reasoning: string | null;
  location: { id: string; name: string; short_code: string } | null;
  ai_account: { id: string; account_number: string; name: string } | null;
  final_account: { id: string; account_number: string; name: string } | null;
  ai_vendor: { id: string; name: string; display_name: string | null } | null;
  bank_account: { id: string; account_name: string; account_mask: string } | null;
  receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING'; chaseCount: number;
}

export function CreditCardDrawer({ txn, onClose }: { txn: CCLike | null; onClose: () => void }) {
  const account = txn ? (txn.final_account ?? txn.ai_account) : null;
  const vendor = txn?.ai_vendor?.display_name ?? txn?.ai_vendor?.name ?? null;
  return (
    <DetailDrawer
      open={!!txn} onClose={onClose} width="md"
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
            <DetailField label="Card" value={txn.bank_account ? `${txn.bank_account.account_name} ·${txn.bank_account.account_mask}` : '--'} />
            <DetailField label="Company" value={txn.location?.name ?? '--'} />
            <DetailField label="Receipt" value={txn.receiptStatus} />
          </DetailSection>
          <DetailSection title="Categorization">
            <DetailField label="GL account" value={account ? `${account.account_number} · ${account.name}` : 'Uncategorized'} />
            <DetailField label="AI confidence" value={txn.ai_confidence != null ? `${Math.round(txn.ai_confidence * 100)}%` : '--'} />
            {txn.ai_reasoning && <DetailField label="AI reasoning" value={txn.ai_reasoning} />}
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
