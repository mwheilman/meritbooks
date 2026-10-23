'use client';

import { Button, InlineNotice, Status, Tag } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import type { OnlineActivity } from '@/lib/invoices/online-activity';

interface PayLinkResp {
  url: string;
  payable: boolean;
  mode: 'live' | 'test' | null;
  methods: string[];
  code: string;
  reason: string | null;
  cardPassThrough: boolean;
  cardFeePct: number;
  qr: { viewBox: number; d: string };
  activity: OnlineActivity;
  timeline: Array<{ type: string; at: string; method: string | null; amountCents: number | null }>;
}

const WHAT: Record<string, string> = {
  VIEWED: 'Opened the invoice',
  PAY_INITIATED: 'Started paying',
  PAY_PROCESSING: 'Bank payment processing',
  PAY_SUCCEEDED: 'Paid online',
  PAY_FAILED: 'Payment failed',
};
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * The invoice drawer's Pay link panel (merit-ui). Copy / open / QR for the hosted
 * link, whether the customer can actually pay online (TEST mode labelled honestly,
 * the reason when not), and what the customer has done with it.
 */
export function PayLinkPanel({ invoiceId }: { invoiceId: string }) {
  const { data, isLoading, error, refetch } = useQuery<PayLinkResp>(`/api/invoices/${invoiceId}/pay-link`, undefined, { scope: false });

  if (isLoading && !data) {
    return <div className="wg-loading" style={{ height: 140 }} aria-busy="true"><span className="bar-l" style={{ width: '50%' }} /></div>;
  }
  if (error || !data) {
    return (
      <InlineNotice tone="neg" title="Couldn't load the pay link.">
        {error ?? 'Try again.'} <Button variant="quiet" onClick={() => void refetch()}>Retry</Button>
      </InlineNotice>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.url);
      addToast('success', 'Copied the pay link');
    } catch {
      addToast('error', 'Could not copy. Select the link and copy it by hand.');
    }
  };
  const a = data.activity;

  return (
    <section className="mb-paylink" aria-label="Pay link" style={{ border: '1px solid var(--line)', background: 'var(--white)', padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="eyebrow">Pay link</span>
            {data.payable
              ? <Status kind="ready">{data.methods.includes('CARD') ? 'Bank transfer or card' : 'Bank transfer'}</Status>
              : <Status kind="track" pip="closed">Can&apos;t pay online</Status>}
            {data.mode === 'test' && data.payable && <Tag tone="warn" title="Stripe test mode: only test cards and accounts can pay">Test mode</Tag>}
            {data.mode === 'live' && data.payable && <Tag tone="pos">Live</Tag>}
          </div>
          <input className="input" readOnly value={data.url} aria-label="Pay link" onFocus={(e) => e.currentTarget.select()} style={{ width: '100%' }} />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Button onClick={() => void copy()}>Copy link</Button>
            <a className="btn" href={data.url} target="_blank" rel="noreferrer">Open</a>
          </div>
          {!data.payable && data.reason && <p className="t-cap" style={{ marginTop: 8 }}>{data.reason}</p>}
          {data.payable && data.methods.includes('CARD') && (
            <p className="t-cap" style={{ marginTop: 8 }}>
              Card fee {data.cardFeePct}% · {data.cardPassThrough ? 'added to what the customer pays' : 'absorbed by the company'}
            </p>
          )}
        </div>
        <svg width={96} height={96} viewBox={`0 0 ${data.qr.viewBox} ${data.qr.viewBox}`} role="img" aria-label="QR code for the pay link" style={{ flex: 'none', border: '1px solid var(--line)' }}>
          <rect width={data.qr.viewBox} height={data.qr.viewBox} fill="var(--white)" />
          <path d={data.qr.d} fill="var(--ink)" />
        </svg>
      </div>

      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <div className="t-cap" style={{ marginBottom: 4 }}>
          {a.paidOnlineAt
            ? `Paid online ${when(a.paidOnlineAt)}${a.paidOnlineCents != null ? ` · ${money(a.paidOnlineCents)}` : ''}`
            : a.views > 0 ? `Opened ${a.views}× · last ${a.lastViewedAt ? when(a.lastViewedAt) : ''}` : 'The customer hasn’t opened the link yet.'}
        </div>
        {data.timeline.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.timeline.slice(0, 6).map((e, i) => (
              <li key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', color: 'var(--ink-2)' }}>
                <span>{WHAT[e.type] ?? e.type}{e.method ? ` · ${e.method === 'CARD' ? 'card' : 'bank'}` : ''}{e.amountCents != null ? ` · ${money(e.amountCents)}` : ''}</span>
                <span className="t-cap tnum">{when(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
