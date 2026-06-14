'use client';

import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { ImageOff, ExternalLink } from 'lucide-react';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';

interface ReceiptDetail {
  id: string; source: string; imageUrl: string | null; submittedAt: string;
  receiptDate: string | null; status: string; vendorName: string | null;
  amountCents: number | null; aiConfidence: number | null; accountLabel: string | null;
  locationName: string; locationCode: string; departmentLabel: string | null;
  classLabel: string | null; chaseReminderCount: number; posted: boolean; matchedToBank: boolean;
}

export function ReceiptDrawer({ receiptId, onClose }: { receiptId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<ReceiptDetail>(
    receiptId ? `/api/receipts/${receiptId}` : '', undefined, { enabled: !!receiptId }
  );

  return (
    <DetailDrawer
      open={!!receiptId} onClose={onClose} width="md"
      title={data?.vendorName ? data.vendorName : 'Receipt'}
      subtitle={data ? `${data.receiptDate ?? data.submittedAt?.split('T')[0] ?? ''}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading} error={error}
      headerRight={data ? <StatusBadge status={data.status} /> : undefined}
    >
      {data && (
        <>
          {data.imageUrl ? (
            <a href={data.imageUrl} target="_blank" rel="noopener noreferrer" className="block relative group mb-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.imageUrl} alt="Receipt" className="w-full max-h-[420px] object-contain rounded-lg bg-slate-950 border border-slate-800" />
              <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black/60 text-2xs text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity">
                <ExternalLink size={11} /> Open image
              </span>
            </a>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 mb-4 text-slate-600 bg-slate-950 border border-slate-800 rounded-lg">
              <ImageOff size={28} /><span className="text-xs mt-2">No image attached</span>
            </div>
          )}

          <DetailSection title="Extracted">
            <DetailField label="Vendor" value={data.vendorName ?? '--'} />
            <DetailField label="Amount" value={data.amountCents != null ? formatMoney(data.amountCents) : '--'} mono />
            <DetailField label="Date" value={data.receiptDate ?? '--'} mono />
            <DetailField label="GL account" value={data.accountLabel ?? 'Uncategorized'} />
            {data.departmentLabel && <DetailField label="Department" value={data.departmentLabel} />}
            {data.classLabel && <DetailField label="Class" value={data.classLabel} />}
            <DetailField label="AI confidence" value={data.aiConfidence != null ? `${Math.round(data.aiConfidence * 100)}%` : '--'} />
          </DetailSection>

          <DetailSection title="Status">
            <DetailField label="Company" value={data.locationName || '--'} />
            <DetailField label="Source" value={data.source.replace('_', ' ')} />
            <DetailField label="Posted to GL" value={data.posted ? 'Yes' : 'No'} />
            <DetailField label="Matched to bank" value={data.matchedToBank ? 'Yes' : 'No'} />
            {data.chaseReminderCount > 0 && <DetailField label="Chase reminders" value={data.chaseReminderCount} />}
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
