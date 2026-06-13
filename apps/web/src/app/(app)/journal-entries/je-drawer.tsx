'use client';

import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';

interface JELineDetail {
  id: string;
  lineNumber: number;
  accountNumber: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  departmentLabel: string | null;
  classLabel: string | null;
}
interface JEDetail {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  memo: string | null;
  sourceModule: string | null;
  status: string;
  postedAt: string | null;
  createdAt: string;
  isReversing: boolean;
  voidReason: string | null;
  locationName: string;
  locationCode: string;
  periodLabel: string | null;
  totalDebitsCents: number;
  totalCreditsCents: number;
  balanced: boolean;
  lines: JELineDetail[];
}

export function JournalEntryDrawer({ entryId, onClose }: { entryId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<JEDetail>(
    entryId ? `/api/journal-entries/${entryId}` : '',
    undefined,
    { enabled: !!entryId }
  );

  return (
    <DetailDrawer
      open={!!entryId}
      onClose={onClose}
      width="lg"
      title={data?.entryNumber ?? 'Journal Entry'}
      subtitle={data ? `${data.entryDate}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={data ? <StatusBadge status={data.status} /> : undefined}
    >
      {data && (
        <>
          <DetailSection title="Entry">
            <DetailField label="Memo" value={data.memo ?? '--'} />
            <DetailField label="Type" value={data.entryType} />
            <DetailField label="Source" value={data.sourceModule ?? '--'} />
            <DetailField label="Company" value={data.locationName || '--'} />
            <DetailField label="Period" value={data.periodLabel ?? '--'} mono />
            <DetailField label="Posted" value={data.postedAt ? new Date(data.postedAt).toLocaleString() : '--'} />
            {data.isReversing && <DetailField label="Reversing" value="Yes" />}
            {data.voidReason && <DetailField label="Void reason" value={data.voidReason} />}
          </DetailSection>

          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
            Lines ({data.lines.length})
          </h3>
          <DetailTable
            columns={[
              { key: 'acct', label: 'Account' },
              { key: 'dim', label: 'Dimensions' },
              { key: 'dr', label: 'Debit', align: 'right' },
              { key: 'cr', label: 'Credit', align: 'right' },
            ]}
          >
            {data.lines.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="px-3 py-2">
                  <div className="text-sm text-slate-200">
                    <span className="font-mono text-xs text-slate-400">{l.accountNumber}</span> {l.accountName}
                  </div>
                  {l.memo && <div className="text-2xs text-slate-500 mt-0.5">{l.memo}</div>}
                </td>
                <td className="px-3 py-2 text-2xs text-slate-500">
                  {[l.departmentLabel, l.classLabel].filter(Boolean).join(' · ') || '--'}
                </td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">
                  {l.debitCents ? formatMoney(l.debitCents) : ''}
                </td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">
                  {l.creditCents ? formatMoney(l.creditCents) : ''}
                </td>
              </tr>
            ))}
            <tr className="border-t border-slate-700 font-medium">
              <td className="px-3 py-2 text-xs text-slate-400" colSpan={2}>Totals</td>
              <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-100">{formatMoney(data.totalDebitsCents)}</td>
              <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-100">{formatMoney(data.totalCreditsCents)}</td>
            </tr>
          </DetailTable>

          <div className={clsx('mt-3 text-xs font-medium', data.balanced ? 'text-emerald-400' : 'text-red-400')}>
            {data.balanced ? '✓ Balanced' : '✗ Out of balance'}
          </div>
        </>
      )}
    </DetailDrawer>
  );
}
