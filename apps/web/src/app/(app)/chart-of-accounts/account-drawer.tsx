'use client';
import { PanelSection, Status } from '@meritbooks/merit-ui';
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
      headerRight={data ? (data.isActive ? <Status kind="ready">Active</Status> : <Status kind="track" pip="closed">Inactive</Status>) : undefined}
    >
      {data && (
        <>
          <DetailSection title="Account">
            <DetailField label="Balance" value={`${formatMoney(data.naturalBalanceCents)} ${data.normalBalance === 'CREDIT' ? 'credit' : data.normalBalance === 'DEBIT' ? 'debit' : data.normalBalance}`} mono />
            <DetailField label="Type" value={data.accountType} />
            {data.accountSubType && <DetailField label="Sub-type" value={data.accountSubType} />}
            <DetailField label="Control account" value={data.isControl ? 'Yes — posts only from its sub-ledger' : 'No'} />
            {data.isBank && <DetailField label="Bank account" value="Yes" />}
            {data.isCreditCard && <DetailField label="Credit card" value="Yes" />}
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
            {data.description && <DetailField label="Description" value={data.description} />}
          </DetailSection>
          <PanelSection
            title="Recent activity"
            meta={<span className="t-cap tnum">{data.activityCount} posted</span>}
          >
            {data.recentActivity.length > 0 ? (
              <DetailTable columns={[{ key: 'e', label: 'Entry' }, { key: 'd', label: 'Date' }, { key: 'dr', label: 'Debit', align: 'right' }, { key: 'cr', label: 'Credit', align: 'right' }]}>
                {data.recentActivity.map((e, i) => (
                  <tr key={e.id + i}>
                    <td className="tnum" title={e.memo ?? undefined}>{e.entryNumber}</td>
                    <td className="tnum ink-2">{e.entryDate}</td>
                    <td className="n">{e.debitCents ? formatMoney(e.debitCents) : ''}</td>
                    <td className="n">{e.creditCents ? formatMoney(e.creditCents) : ''}</td>
                  </tr>
                ))}
              </DetailTable>
            ) : (
              <p className="t-cap">No posted activity yet. Entries that post to this account will show here.</p>
            )}
          </PanelSection>
        </>
      )}
    </DetailDrawer>
  );
}
