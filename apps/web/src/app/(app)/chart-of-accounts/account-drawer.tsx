'use client';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';

interface AcctDetail {
  id: string; accountNumber: string; name: string; accountType: string; accountSubType: string | null;
  isControl: boolean; isBank: boolean; isCreditCard: boolean; isActive: boolean; description: string | null;
  naturalBalanceCents: number; normalBalance: string; activityCount: number;
  recentActivity: Array<{ id: string; entryNumber: string; entryDate: string; debitCents: number; creditCents: number; memo: string | null }>;
}

export function AccountDrawer({ accountId, onClose }: { accountId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<AcctDetail>(accountId ? `/api/accounts/${accountId}` : '', undefined, { enabled: !!accountId });
  return (
    <DetailDrawer
      open={!!accountId} onClose={onClose} width="lg"
      title={data ? `${data.accountNumber} · ${data.name}` : 'Account'}
      subtitle={data ? `${data.accountType}${data.accountSubType ? ` · ${data.accountSubType}` : ''}` : null}
      isLoading={isLoading} error={error}
    >
      {data && (
        <>
          <DetailSection title="Account">
            <DetailField label="Balance" value={`${formatMoney(data.naturalBalanceCents)} ${data.normalBalance}`} mono />
            <DetailField label="Type" value={data.accountType} />
            {data.accountSubType && <DetailField label="Sub-type" value={data.accountSubType} />}
            <DetailField label="Control account" value={data.isControl ? 'Yes' : 'No'} />
            {data.isBank && <DetailField label="Bank account" value="Yes" />}
            {data.isCreditCard && <DetailField label="Credit card" value="Yes" />}
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
            {data.description && <DetailField label="Description" value={data.description} />}
          </DetailSection>
          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Recent activity ({data.activityCount} posted)</h3>
          {data.recentActivity.length > 0 ? (
            <DetailTable columns={[{ key: 'e', label: 'Entry' }, { key: 'd', label: 'Date' }, { key: 'dr', label: 'Debit', align: 'right' }, { key: 'cr', label: 'Credit', align: 'right' }]}>
              {data.recentActivity.map((e, i) => (
                <tr key={e.id + i}>
                  <td className="px-3 py-2 text-sm font-mono text-slate-300">{e.entryNumber}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 font-mono">{e.entryDate}</td>
                  <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{e.debitCents ? formatMoney(e.debitCents) : ''}</td>
                  <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{e.creditCents ? formatMoney(e.creditCents) : ''}</td>
                </tr>
              ))}
            </DetailTable>
          ) : <p className="text-xs text-slate-500">No posted activity yet.</p>}
        </>
      )}
    </DetailDrawer>
  );
}
