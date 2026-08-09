'use client';

import { LayoutGrid, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { SectionTabs, useSectionTab, type SectionTab } from '../_components/section-tabs';
import { BudgetsWorkspace } from './budgets-workspace';
import { DriverBuilder } from './drivers/driver-builder';
import { ReforecastView } from './reforecast/reforecast-view';

/**
 * Budgets parent shell. Folds the former standalone /budgets/drivers and
 * /budgets/reforecast routes in as tabs so budgeting lives on one screen:
 *   • Plan          — author budgets by account + budget-vs-actual (BudgetsWorkspace)
 *   • Driver Builder — build a full-year plan from driver assumptions
 *   • Reforecast    — blend actuals + projection into a rolling latest-estimate
 * The retired routes redirect to /budgets?tab=drivers|reforecast.
 */
const TABS: SectionTab[] = [
  { id: 'plan', label: 'Plan', icon: <LayoutGrid size={14} /> },
  { id: 'drivers', label: 'Driver Builder', icon: <SlidersHorizontal size={14} /> },
  { id: 'reforecast', label: 'Reforecast', icon: <TrendingUp size={14} /> },
];

const VALID = ['plan', 'drivers', 'reforecast'] as const;

export function BudgetsTabs() {
  const [tab, setTab] = useSectionTab(VALID, 'plan');

  return (
    <div className="space-y-6">
      <SectionTabs tabs={TABS} active={tab} onChange={(id) => setTab(id as typeof VALID[number])} />
      {tab === 'plan' && <BudgetsWorkspace />}
      {tab === 'drivers' && <DriverBuilder />}
      {tab === 'reforecast' && <ReforecastView />}
    </div>
  );
}
