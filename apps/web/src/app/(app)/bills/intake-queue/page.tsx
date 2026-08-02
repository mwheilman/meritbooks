import { requirePagePermission } from '@/lib/rbac/page-guard';
import { IntakeQueueClient } from './intake-queue-client';

export const dynamic = 'force-dynamic';

/**
 * AP document-reading intake queue.
 *
 * PAGE-LEVEL RBAC (identity gate #9): only roles that may view Bills/AP reach this
 * screen. Route handlers enforce create/dispose independently. Fails closed.
 */
export default async function IntakeQueuePage() {
  await requirePagePermission('bills', 'view');
  return <IntakeQueueClient />;
}
