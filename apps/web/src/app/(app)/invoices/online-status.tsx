'use client';

import { Status, type PipKind, type StatusKind } from '@meritbooks/merit-ui';
import type { OnlineStatus } from '@/lib/invoices/online-activity';

/** The invoice list's "Online" column — what the customer did with the pay link. */
export interface OnlineSummary {
  status: OnlineStatus;
  label: string;
  views: number;
  paidOnlineAt: string | null;
}

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
  return (
    <span title={title}>
      <Status kind={k.kind} pip={k.pip}>{online.label}</Status>
    </span>
  );
}
