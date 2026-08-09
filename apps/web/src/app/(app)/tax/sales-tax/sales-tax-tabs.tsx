'use client';

import { FileText, CalendarClock } from 'lucide-react';
import { SectionTabs, useSectionTab, type SectionTab } from '../../_components/section-tabs';
import { HubTabs } from '../../_components/hub-tabs';
import { SalesTaxReturnView } from '../../sales-tax-return/sales-tax-return-view';
import { SalesTaxCalendarView } from '../../sales-tax-calendar/sales-tax-calendar-view';

/**
 * Sales Tax sub-screen of the Tax hub. Merges the former standalone
 * /sales-tax-return (Worksheet) and /sales-tax-calendar (Calendar) routes into one
 * screen with inner tabs; both standalones redirect here with ?tab=worksheet|calendar.
 */
const TABS: SectionTab[] = [
  { id: 'worksheet', label: 'Worksheet', icon: <FileText size={14} /> },
  { id: 'calendar', label: 'Filing Calendar', icon: <CalendarClock size={14} /> },
];

const VALID = ['worksheet', 'calendar'] as const;

export function SalesTaxTabs() {
  const [tab, setTab] = useSectionTab(VALID, 'worksheet');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <HubTabs section="tax" />
      <div className="mb-6">
        <SectionTabs tabs={TABS} active={tab} onChange={(id) => setTab(id as typeof VALID[number])} />
      </div>
      {tab === 'worksheet' ? <SalesTaxReturnView /> : <SalesTaxCalendarView />}
    </div>
  );
}
