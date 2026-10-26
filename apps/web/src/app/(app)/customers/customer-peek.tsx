'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Pip, Tag } from '@meritbooks/merit-ui';

interface CustDetail {
  name: string; email: string | null; phone: string | null; contactName: string | null;
  paymentTermsDays: number | null; isPortfolioCompany: boolean;
  ar: { totalOutstanding: number; overdueCount: number; openInvoiceCount: number };
  recentInvoices: Array<{ id: string; invoiceNumber: string; balanceCents: number }>;
}

/** Hover preview of a customer (kit classes + inline layout only — the peek card portals to <body>). */
export function CustomerPeek({ customerId }: { customerId: string }) {
  const { data, loading } = usePeekDetail<CustDetail>(`/api/customers/${customerId}`);
  if (loading && !data) {
    return (
      <div className="wg-loading" aria-busy="true" style={{ display: 'grid', gap: 10, padding: 16 }}>
        <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '80%' }} aria-hidden="true" />
        <span className="sr" role="status">Loading the preview</span>
      </div>
    );
  }
  if (!data) return <p className="t-cap" style={{ padding: '24px 16px', textAlign: 'center' }}>Preview unavailable. Open the customer for the full record.</p>;
  return (
    <div style={{ padding: 16 }}>
      <div className="row" style={{ marginBottom: 8, minWidth: 0 }}>
        <span className="t-head mb-trunc" style={{ flex: 1 }}>{data.name}</span>
        {data.isPortfolioCompany && <Tag tone="ai">Internal</Tag>}
      </div>
      {(data.contactName || data.email || data.phone) && (
        <div style={{ marginBottom: 12 }}>
          {data.contactName && <span className="l1">{data.contactName}</span>}
          {data.email && <span className="l2">{data.email}</span>}
          {data.phone && <span className="l2">{data.phone}</span>}
        </div>
      )}
      <div className="mb-detail-rows">
        <div className="mb-detail-row">
          <span className="ink-2">Open A/R</span>
          <span className="tnum">{formatMoney(data.ar.totalOutstanding)}</span>
        </div>
        <div className="mb-detail-row">
          <span className="ink-2">
            <span className="tnum">{data.ar.openInvoiceCount}</span> open invoice{data.ar.openInvoiceCount !== 1 ? 's' : ''}
          </span>
          {data.ar.overdueCount > 0 ? (
            <span className="mb-sev"><Pip kind="overdue" /><span className="tnum">{data.ar.overdueCount}</span> overdue</span>
          ) : (
            <span className="ink-3">None overdue</span>
          )}
        </div>
      </div>
      {data.paymentTermsDays != null && <p className="t-cap" style={{ marginTop: 8 }}>Terms: Net {data.paymentTermsDays}</p>}
    </div>
  );
}
