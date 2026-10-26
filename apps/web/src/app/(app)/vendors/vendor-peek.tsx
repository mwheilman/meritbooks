'use client';
import { usePeekDetail } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';
import { Pip, Tag } from '@meritbooks/merit-ui';

interface VenDetail {
  name: string; email: string | null; phone: string | null; paymentTermsDays: number | null;
  is1099: boolean; autoApprove: boolean;
  compliance: { hasPaymentHold: boolean };
  ap: { openBalance: number; overdueCount: number; openBillCount: number };
}

/** Hover preview of a vendor (kit classes + inline layout only — the peek card portals to <body>). */
export function VendorPeek({ vendorId }: { vendorId: string }) {
  const { data, loading } = usePeekDetail<VenDetail>(`/api/vendors/${vendorId}`);
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
  if (!data) return <p className="t-cap" style={{ padding: '24px 16px', textAlign: 'center' }}>Preview unavailable. Open the vendor for the full record.</p>;
  return (
    <div style={{ padding: 16 }}>
      <div className="row" style={{ marginBottom: 8, minWidth: 0 }}>
        <span className="t-head mb-trunc" style={{ flex: 1 }}>{data.name}</span>
        {data.is1099 && <Tag>1099</Tag>}
        {data.compliance.hasPaymentHold && <Tag tone="neg">On hold</Tag>}
      </div>
      {(data.email || data.phone) && (
        <div style={{ marginBottom: 12 }}>
          {data.email && <span className="l2">{data.email}</span>}
          {data.phone && <span className="l2">{data.phone}</span>}
        </div>
      )}
      <div className="mb-detail-rows">
        <div className="mb-detail-row">
          <span className="ink-2">Open A/P</span>
          <span className="tnum">{formatMoney(data.ap.openBalance)}</span>
        </div>
        <div className="mb-detail-row">
          <span className="ink-2">
            <span className="tnum">{data.ap.openBillCount}</span> open bill{data.ap.openBillCount !== 1 ? 's' : ''}
          </span>
          {data.ap.overdueCount > 0 ? (
            <span className="mb-sev"><Pip kind="overdue" /><span className="tnum">{data.ap.overdueCount}</span> overdue</span>
          ) : (
            <span className="ink-3">None overdue</span>
          )}
        </div>
      </div>
      <div className="row row--between t-cap" style={{ marginTop: 8 }}>
        {data.paymentTermsDays != null ? <span>Terms: Net {data.paymentTermsDays}</span> : <span />}
        {data.autoApprove && <span>Auto-approve on</span>}
      </div>
    </div>
  );
}
