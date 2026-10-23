'use client';

import { Status, Tag, type PipKind, type StatusKind } from '@meritbooks/merit-ui';
import type { OnlineStatus } from '@/lib/invoices/online-activity';

/** The invoice list's "Online" column — what the customer did with the pay link. */
export interface OnlineSummary {
  status: OnlineStatus;
  label: string;
  views: number;
  paidOnlineAt: string | null;
  /** Can the customer pay online right now (lib/invoices/pay-link.ts)? null = unknown. */
  payable?: boolean | null;
  payMethods?: string[];
  payReason?: string | null;
  payCode?: string | null;
}

const OPEN_STATUSES = new Set(['SENT', 'PARTIALLY_PAID', 'OVERDUE']);

const KIND: Record<OnlineStatus, { kind: StatusKind; pip?: PipKind }> = {
  PAID_ONLINE: { kind: 'ready' },
  PROCESSING: { kind: 'track', pip: 'open' },
  FAILED: { kind: 'blocked' },
  STARTED: { kind: 'risk', pip: 'soft' },
  VIEWED: { kind: 'track' },
  NOT_VIEWED: { kind: 'track', pip: 'closed' },
};

export function OnlineStatusCell({ online, status }: { online?: OnlineSummary; status: string }) {
  if (!online || status === 'DRAFT') return <span className="t-cap">—</span>;
  const k = KIND[online.status];
  const title = online.paidOnlineAt
    ? `Paid online ${new Date(online.paidOnlineAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : online.views > 0 ? `Customer opened the invoice ${online.views} time${online.views === 1 ? '' : 's'}` : 'The customer has not opened the online invoice yet';
  const settled = online.status === 'PAID_ONLINE' || online.status === 'PROCESSING';
  // An open invoice the customer can't pay online says so here — the same answer as the
  // drawer's Pay link panel, the PDF and the hosted page.
  const offline = OPEN_STATUSES.has(status) && !settled && online.payable === false;
  const methods = online.payMethods ?? [];
  const via = methods.includes('ACH') && methods.includes('CARD') ? 'bank transfer or card' : methods.includes('CARD') ? 'card' : 'bank transfer';
  return (
    <span title={offline ? `${title}. ${online.payReason ?? 'Online payment is off for this invoice.'}` : online.payable ? `${title}. Payable online by ${via}.` : title}
      style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <Status kind={k.kind} pip={k.pip}>{online.label}</Status>
      {offline && <Tag tone="warn">Can&apos;t pay online</Tag>}
    </span>
  );
}
