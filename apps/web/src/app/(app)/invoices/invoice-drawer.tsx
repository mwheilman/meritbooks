'use client';

import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';

interface InvLine {
  id: string; lineNumber: number; description: string;
  quantity: number; unitPriceCents: number; amountCents: number;
  accountNumber: string; accountName: string;
}
interface InvDetail {
  id: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  status: string; memo: string | null; isProgressBill: boolean;
  subtotalCents: number; taxCents: number; totalCents: number;
  amountPaidCents: number; balanceCents: number;
  customerName: string; customerEmail: string | null;
  locationName: string; locationCode: string; jobLabel: string | null;
  lines: InvLine[];
}

export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<InvDetail>(
    invoiceId ? `/api/invoices/${invoiceId}` : '',
    undefined,
    { enabled: !!invoiceId }
  );

  return (
    <DetailDrawer
      open={!!invoiceId}
      onClose={onClose}
      width="lg"
      title={data?.invoiceNumber ? `Invoice ${data.invoiceNumber}` : 'Invoice'}
      subtitle={data ? `${data.customerName}${data.locationCode ? ` · ${data.locationCode}` : ''}` : null}
      isLoading={isLoading}
      error={error}
      headerRight={data ? <StatusBadge status={data.status} /> : undefined}
    >
      {data && (
        <>
          <DetailSection title="Invoice">
            <DetailField label="Customer" value={data.customerName || '--'} />
            {data.customerEmail && <DetailField label="Email" value={data.customerEmail} />}
            <DetailField label="Company" value={data.locationName || '--'} />
            {data.jobLabel && <DetailField label="Job" value={data.jobLabel} />}
            <DetailField label="Invoice date" value={data.invoiceDate} mono />
            <DetailField label="Due date" value={data.dueDate} mono />
            {data.isProgressBill && <DetailField label="Progress bill" value="AIA" />}
            {data.memo && <DetailField label="Memo" value={data.memo} />}
          </DetailSection>

          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
            Lines ({data.lines.length})
          </h3>
          <DetailTable
            columns={[
              { key: 'desc', label: 'Description' },
              { key: 'qty', label: 'Qty', align: 'right' },
              { key: 'price', label: 'Unit', align: 'right' },
              { key: 'amt', label: 'Amount', align: 'right' },
            ]}
          >
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2">
                  <div className="text-sm text-slate-200">{l.description}</div>
                  <div className="text-2xs text-slate-500 mt-0.5 font-mono">{l.accountNumber} · {l.accountName}</div>
                </td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{l.quantity}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(l.unitPriceCents)}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(l.amountCents)}</td>
              </tr>
            ))}
          </DetailTable>

          <DetailSection title="">
            <DetailField label="Subtotal" value={formatMoney(data.subtotalCents)} mono />
            <DetailField label="Tax" value={formatMoney(data.taxCents)} mono />
            <DetailField label="Total" value={formatMoney(data.totalCents)} mono />
            <DetailField label="Paid" value={formatMoney(data.amountPaidCents)} mono />
            <DetailField label="Balance" value={formatMoney(data.balanceCents)} mono />
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
