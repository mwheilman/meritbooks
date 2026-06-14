'use client';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';

interface IILine { id: string; description: string; amount_cents: number; }
interface IIDetail {
  id: string; invoice_number: string; invoice_date: string; memo: string | null;
  status: string; charge_method: string; total_cents: number;
  lines: IILine[];
  location?: { name: string; short_code: string } | null;
  provider?: { name: string; code: string } | null;
  receiver?: { name: string; code: string } | null;
}

export function InternalInvoiceDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const { data: resp, isLoading, error } = useQuery<{ data: IIDetail }>(
    invoiceId ? `/api/internal-invoices/${invoiceId}` : '', undefined, { enabled: !!invoiceId }
  );
  const d = resp?.data;
  return (
    <DetailDrawer
      open={!!invoiceId} onClose={onClose} width="lg"
      title={d ? `Internal ${d.invoice_number}` : 'Internal Invoice'}
      subtitle={d ? `${d.provider?.name ?? '?'} → ${d.receiver?.name ?? '?'}` : null}
      isLoading={isLoading} error={error}
    >
      {d && (
        <>
          <DetailSection title="Charge">
            <DetailField label="Provider" value={d.provider ? `${d.provider.code} · ${d.provider.name}` : '--'} />
            <DetailField label="Receiver" value={d.receiver ? `${d.receiver.code} · ${d.receiver.name}` : '--'} />
            <DetailField label="Method" value={d.charge_method === 'cost_transfer' ? 'Cost transfer' : 'Revenue'} />
            <DetailField label="Company" value={d.location?.name ?? '--'} />
            <DetailField label="Date" value={d.invoice_date} mono />
            <DetailField label="Status" value={d.status} />
            {d.memo && <DetailField label="Memo" value={d.memo} />}
          </DetailSection>
          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Lines ({d.lines.length})</h3>
          <DetailTable columns={[{ key: 'd', label: 'Description' }, { key: 'a', label: 'Amount', align: 'right' }]}>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2 text-sm text-slate-200">{l.description}</td>
                <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(l.amount_cents)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-700 font-medium">
              <td className="px-3 py-2 text-xs text-slate-400">Total</td>
              <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-100">{formatMoney(d.total_cents)}</td>
            </tr>
          </DetailTable>
        </>
      )}
    </DetailDrawer>
  );
}
