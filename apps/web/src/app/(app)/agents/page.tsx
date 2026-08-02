import { requirePagePermission } from '@/lib/rbac/page-guard';
import { AgentsClient } from './AgentsClient';

export const dynamic = 'force-dynamic';

/**
 * Supervised Agents (M9) — the run list + step-timeline surface for the agentic
 * orchestration framework. PAGE-LEVEL RBAC (identity gate #9): only roles that may
 * view Bills/AP reach this screen; route handlers enforce start/advance separately.
 * Fails closed.
 */
export default async function AgentsPage() {
  await requirePagePermission('bills', 'view');
  return <AgentsClient />;
}
