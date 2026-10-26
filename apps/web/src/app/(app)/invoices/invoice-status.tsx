'use client';

import { Status, type PipKind, type StatusKind } from '@meritbooks/merit-ui';
import { INVOICE_STATUS_LABELS, type InvoiceDisplayKey } from '@/lib/invoices/display-status';

/**
 * The invoice status chip — ONE look for the list, the drawer and the peek. The key comes
 * from `deriveInvoiceStatus` (lib/invoices/display-status.ts) on the server, so every
 * surface shows the same word for the same invoice. Pip shape + word (never colour alone).
 */
const LOOK: Record<InvoiceDisplayKey, { kind: StatusKind; pip?: PipKind }> = {
  DRAFT: { kind: 'track', pip: 'closed' },
  ISSUED: { kind: 'track', pip: 'open' },
  SENT: { kind: 'track', pip: 'open' },
  PARTIALLY_PAID: { kind: 'risk', pip: 'soft' },
  PAID: { kind: 'ready' },
  OVERDUE: { kind: 'overdue' },
  VOIDED: { kind: 'track', pip: 'closed' },
  WRITTEN_OFF: { kind: 'blocked', pip: 'closed' },
};

function keyOf(status: string): InvoiceDisplayKey {
  return (Object.prototype.hasOwnProperty.call(LOOK, status) ? status : 'DRAFT') as InvoiceDisplayKey;
}

export function InvoiceStatus({ status, daysOverdue, hint }: { status: string; daysOverdue?: number; hint?: string | null }) {
  const k = keyOf(status);
  const c = LOOK[k];
  const word = k === 'OVERDUE' && daysOverdue && daysOverdue > 0 ? `Overdue · ${daysOverdue}d late` : INVOICE_STATUS_LABELS[k];
  return (
    <span title={hint ?? undefined}>
      <Status kind={c.kind} pip={c.pip}>{word}</Status>
    </span>
  );
}
