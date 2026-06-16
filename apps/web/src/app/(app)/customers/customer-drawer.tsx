'use client';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

interface CustDetail {
  id: string; name: string; legalName: string; email: string | null; phone: string | null;
  contactName: string | null; addressLine: string | null; website: string | null;
  paymentTermsDays: number | null; creditLimitCents: number | null; taxExempt: boolean;
  isPortfolioCompany: boolean; isActive: boolean; notes: string | null;
  ar: { totalOutstanding: number; overdueCount: number; openInvoiceCount: number };
  recentInvoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; totalCents: number; balanceCents: number; status: string }>;
}

export function CustomerDrawer({ customerId, onClose, onEdit }: { customerId: string | null; onClose: () => void; onEdit?: () => void }) {
  const { data, isLoading, error } = useQuery<CustDetail>(customerId ? `/api/customers/${customerId}` : '', undefined, { enabled: !!customerId });
  return (
    <DetailDrawer
      open={!!customerId} onClose={onClose} width="lg"
      title={data?.name ?? 'Customer'}
      subtitle={data?.isPortfolioCompany ? 'Portfolio company' : 'External customer'}
      isLoading={isLoading} error={error}
      headerRight={data && onEdit ? (
        <button onClick={onEdit} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">Edit</button>
      ) : undefined}
    >
      {data && (
        <>
          <DetailSection title="Contact">
            {data.contactName && <DetailField label="Contact" value={data.contactName} />}
            <DetailField label="Email" value={data.email ?? '--'} />
            <DetailField label="Phone" value={data.phone ?? '--'} />
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
            {data.website && <DetailField label="Website" value={data.website} />}
          </DetailSection>
          <DetailSection title="Terms">
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '--'} />
            <DetailField label="Credit limit" value={data.creditLimitCents != null ? formatMoney(data.creditLimitCents) : '--'} mono />
            <DetailField label="Tax exempt" value={data.taxExempt ? 'Yes' : 'No'} />
            <DetailField label="Status" value={data.isActive ? 'Active' : 'Inactive'} />
          </DetailSection>
          <DetailSection title="Accounts receivable">
            <DetailField label="Open balance" value={formatMoney(data.ar.totalOutstanding)} mono />
            <DetailField label="Open invoices" value={data.ar.openInvoiceCount} />
            <DetailField label="Overdue" value={data.ar.overdueCount} />
          </DetailSection>

          <DetailSection title="Invoice settings">
            <EntityInvoiceSettings scope="CUSTOMER" id={data.id} />
          </DetailSection>

          <DetailSection title="Customer-facing invoice text">
            <InvoiceTextOverrides scope="CUSTOMER" refId={data.id} />
          </DetailSection>
          {data.recentInvoices.length > 0 && (
            <>
              <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Recent invoices</h3>
              <DetailTable columns={[{ key: 'n', label: 'Invoice' }, { key: 'd', label: 'Date' }, { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' }]}>
                {data.recentInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{inv.invoiceNumber}</td>
                    <td className="px-3 py-2 text-xs text-slate-400 font-mono">{inv.invoiceDate}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(inv.balanceCents)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={inv.status} /></td>
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
