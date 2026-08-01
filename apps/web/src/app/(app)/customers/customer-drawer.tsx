'use client';
import { useState } from 'react';
import { FileText, Download, Send, Loader2 } from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';

type StatementMode = 'open' | 'activity';

/**
 * AR statement controls (FPB-invoices §7): pick open-item vs activity + an
 * as-of date, then preview/download the branded PDF or email it to the customer.
 * The GET route streams the PDF (opened in a new tab); the send route emails it
 * via the same transport as invoices and degrades gracefully when email isn't
 * configured — the toast surfaces the real reason, never a generic failure.
 */
function StatementActions({ customerId, hasEmail }: { customerId: string; hasEmail: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState<StatementMode>('open');
  const [asOf, setAsOf] = useState(today);
  const [sending, setSending] = useState(false);

  const query = () => {
    const p = new URLSearchParams({ mode });
    if (asOf && asOf !== today) p.set('as_of', asOf);
    return p.toString();
  };

  const preview = (download: boolean) => {
    const p = new URLSearchParams(query());
    if (download) p.set('download', '1');
    window.open(`/api/customers/${customerId}/statement?${p.toString()}`, '_blank', 'noopener');
  };

  const send = async () => {
    if (!hasEmail) {
      addToast('error', 'This customer has no email address on file.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/statement/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, as_of: asOf }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.sent) {
        addToast('success', `Statement emailed to ${body.to}`);
      } else {
        // Distinct reasons: not configured, no email, provider rejected.
        addToast('error', body.error ?? 'Could not send the statement.');
      }
    } catch {
      addToast('error', 'Could not reach the send service. Try again.');
    } finally {
      setSending(false);
    }
  };

  const toggle = 'px-2.5 py-1 rounded-md text-xs font-medium transition-colors';
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setMode('open')} className={`${toggle} ${mode === 'open' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>Open items</button>
        <button onClick={() => setMode('activity')} className={`${toggle} ${mode === 'activity' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>Activity</button>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-2xs text-slate-500 uppercase tracking-wider">As of</span>
          <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value || today)}
            className="px-2 py-1 rounded-md bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => preview(false)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
          <FileText size={12} /> Preview
        </button>
        <button onClick={() => preview(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">
          <Download size={12} /> Download
        </button>
        <button onClick={send} disabled={sending || !hasEmail}
          title={hasEmail ? 'Email this statement to the customer' : 'No customer email on file'}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed">
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          {sending ? 'Sending…' : 'Send statement'}
        </button>
      </div>
      {!hasEmail && (
        <p className="text-2xs text-slate-500">Add an email address to enable sending. Preview and download always work.</p>
      )}
    </div>
  );
}

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

          <DetailSection title="Statement">
            <StatementActions customerId={data.id} hasEmail={!!data.email} />
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
