import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ReceiptsScreen } from './receipts-screen';

export const metadata = { title: 'Receipts' };

/**
 * RECEIPTS (FPB-workforce-app §15) — receipt chase board, receipts inbox with drag-drop
 * upload and matching, cardholders, and the receipt policy + chase switch. Built on
 * merit-ui. Page-level RBAC: receipts:view (fails closed before any client JS).
 */
export default async function ReceiptsPage() {
  await requirePagePermission('receipts', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading receipts…</p>}>
      <ReceiptsScreen />
    </Suspense>
  );
}
