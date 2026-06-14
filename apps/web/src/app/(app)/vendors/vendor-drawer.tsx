'use client';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';

interface VenDetail {
  id: string; name: string; legalName: string; email: string | null; phone: string | null;
  addressLine: string | null; paymentTermsDays: number | null; is1099: boolean; autoApprove: boolean;
  taxId: string | null; isActive: boolean;
  compliance: { w9: string | null; hasPaymentHold: boolean };
  ap: { openBalance: number; overdueCount: number; openBillCount: number };
  recentBills: Array<{ id: string; billNumber: string | null; billDate: string; totalCents: number; balanceCents: number; status: string }>;
}

export function VendorDrawer({ vendorId, onClose }: { vendorId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<VenDetail>(vendorId ? `/api/vendors/${vendorId}` : '', undefined, { enabled: !!vendorId });
  return (
    <DetailDrawer
      open={!!vendorId} onClose={onClose} width="lg"
      title={data?.name ?? 'Vendor'}
      subtitle={data?.is1099 ? '1099 vendor' : undefined}
      isLoading={isLoading} error={error}
      headerRight={data?.compliance.hasPaymentHold ? <StatusBadge status="HOLD" /> : undefined}
    >
      {data && (
        <>
          <DetailSection title="Contact">
            <DetailField label="Legal name" value={data.legalName} />
            <DetailField label="Email" value={data.email ?? '--'} />
            <DetailField label="Phone" value={data.phone ?? '--'} />
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
          </DetailSection>
          <DetailSection title="Terms & compliance">
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '--'} />
            <DetailField label="1099 eligible" value={data.is1099 ? 'Yes' : 'No'} />
            <DetailField label="Auto-approve" value={data.autoApprove ? 'Yes' : 'No'} />
            <DetailField label="Payment hold" value={data.compliance.hasPaymentHold ? 'Yes' : 'No'} />
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
          </DetailSection>
          <DetailSection title="Accounts payable">
            <DetailField label="Open balance" value={formatMoney(data.ap.openBalance)} mono />
            <DetailField label="Open bills" value={data.ap.openBillCount} />
            <DetailField label="Overdue" value={data.ap.overdueCount} />
          </DetailSection>
          {data.recentBills.length > 0 && (
            <>
              <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Recent bills</h3>
              <DetailTable columns={[{ key: 'n', label: 'Bill' }, { key: 'd', label: 'Date' }, { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' }]}>
                {data.recentBills.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{b.billNumber ?? '--'}</td>
                    <td className="px-3 py-2 text-xs text-slate-400 font-mono">{b.billDate}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(b.balanceCents)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            </>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
