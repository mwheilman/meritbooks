import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { AutomationScreen, type AutomationTab } from './automation-screen';

export const dynamic = 'force-dynamic';

const TABS: ReadonlyArray<AutomationTab> = ['jobs', 'dunning', 'late_fees'];

/**
 * Settings → Automation (Wave 2E, docs/SCHEDULER.md): every scheduled job with its on/off
 * switch, last run, outcome and "Run now"; the dunning ladder; the late-fee policy and its
 * approval queue. PAGE-LEVEL RBAC: settings_system:view (fails closed before any client JS);
 * every write route re-checks its own permission.
 */
export default async function AutomationPage({ searchParams }: { searchParams: { tab?: string } }) {
  await requirePagePermission('settings_system', 'view');
  const tab = TABS.find((t) => t === searchParams?.tab) ?? 'jobs';
  return (
    <Suspense fallback={<p className="t-cap">Loading automation…</p>}>
      <AutomationScreen initialTab={tab} />
    </Suspense>
  );
}
