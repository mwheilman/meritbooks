'use client';

import { PageHeader } from '@/components/ui';
import { Wallet, CalendarRange } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { CashDashboard } from './cash-dashboard';
import { CashForecast } from './cash-forecast';
import { ForecastGrid } from '../forecast/forecast-grid';

const TABS = ['position', 'forecast'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  position: 'Real-time cash across all entities with AI intelligence',
  forecast: 'Direct 13-week cash projection from bank balances, open AR, and open AP by due date',
};

export function CashTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'position');

  return (
    <>
      <PageHeader
        title="Cash Position"
        description={DESCRIPTIONS[tab]}
        actions={
          <SectionTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'position', label: 'Cash Position', icon: <Wallet size={14} /> },
              { id: 'forecast', label: '13-Week Forecast', icon: <CalendarRange size={14} /> },
            ]}
          />
        }
      />

      {tab === 'position' && (
        <>
          <CashDashboard />
          <div className="mt-8">
            <CashForecast />
          </div>
        </>
      )}
      {tab === 'forecast' && <ForecastGrid />}
    </>
  );
}
