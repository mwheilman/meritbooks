'use client';

import { SectionTabs, useSectionTab, type SectionTab } from '../_components/section-tabs';
import { BudgetScopeProvider, useBudgetScope } from './budget-scope';
import { BudgetsWorkspace } from './budgets-workspace';
import { CompareView } from './compare-view';
import { DepartmentsTab } from './departments-board';
import { DriverBuilder } from './drivers/driver-builder';
import { PlanWorkspace } from './plan-workspace';
import { ReforecastView } from './reforecast/reforecast-view';
import { TemplateLibrary } from './template-library';

/**
 * Budgets parent shell (Wave 4B, migration 189):
 *   • Plan         — versions + the department × account × month grid (drivers, templates, upload)
 *   • Departments  — submission board, department BvA, bridges, variance explanations
 *   • Compare      — two versions side by side
 *   • Templates    — recommended + tenant department templates
 *   • Classic      — the original entry grid, budget-vs-actual and scenario modeler
 *   • Driver Builder / Reforecast — unchanged
 * Company, year and version are shared across the first four tabs. ?tab= deep links keep working.
 * A department-scoped caller (a department owner) sees only Plan / Departments / Compare / Templates.
 */
const TABS: SectionTab[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'departments', label: 'Departments' },
  { id: 'compare', label: 'Compare' },
  { id: 'templates', label: 'Templates' },
  { id: 'classic', label: 'Classic & scenarios' },
  { id: 'drivers', label: 'Driver Builder' },
  { id: 'reforecast', label: 'Reforecast' },
];

// 'entry' / 'variance' / 'scenarios' are the old in-page tab ids other screens deep-link to (e.g. FP&A → ?tab=scenarios).
const VALID = ['plan', 'departments', 'compare', 'templates', 'classic', 'drivers', 'reforecast', 'entry', 'variance', 'scenarios'] as const;
const CLASSIC = new Set<string>(['classic', 'entry', 'variance', 'scenarios']);

export function BudgetsTabs() {
  return (
    <BudgetScopeProvider>
      <BudgetsTabsInner />
    </BudgetScopeProvider>
  );
}

/** Company-wide screens (classic grid, driver builder, reforecast) aren't department-scoped, so a department owner sees only the scoped tabs. */
const DEPARTMENT_TABS = new Set<string>(['plan', 'departments', 'compare', 'templates']);

function BudgetsTabsInner() {
  const [tab, setTab] = useSectionTab(VALID, 'plan');
  const { access } = useBudgetScope();
  const departmentScoped = access?.scope === 'DEPARTMENTS';
  const tabs = departmentScoped ? TABS.filter((t) => DEPARTMENT_TABS.has(t.id)) : TABS;
  const active = CLASSIC.has(tab) ? 'classic' : tab;
  const shown = departmentScoped && !DEPARTMENT_TABS.has(active) ? 'plan' : active;

  return (
    <div className="space-y-6">
      <SectionTabs tabs={tabs} active={shown} onChange={(id) => setTab(id as (typeof VALID)[number])} />
      {shown === 'plan' && <PlanWorkspace />}
      {shown === 'departments' && <DepartmentsTab />}
      {shown === 'compare' && <CompareView />}
      {shown === 'templates' && <TemplateLibrary />}
      {shown === 'classic' && <BudgetsWorkspace />}
      {shown === 'drivers' && <DriverBuilder />}
      {shown === 'reforecast' && <ReforecastView />}
    </div>
  );
}
