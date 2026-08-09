'use client';

import { PageHeader } from '@/components/ui';
import { Landmark, ShieldCheck } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { DebtRegister } from './debt-register';
import { CovenantsDashboard } from '../covenants/covenants-dashboard';

const TABS = ['register', 'covenants'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  register:
    'Drop a loan document — AI extracts the terms, you confirm, and MeritBooks builds the amortization schedule and posts the interest accrual to the ledger',
  covenants:
    'Track loan covenants against the live ledger — current headroom, trend, and the projected breach date off your cash forecast',
};

export function DebtTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'register');

  return (
    <>
      <PageHeader
        title="Debt & Loans"
        description={DESCRIPTIONS[tab]}
        actions={
          <SectionTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'register', label: 'Debt & Loans', icon: <Landmark size={14} /> },
              { id: 'covenants', label: 'Covenant Monitor', icon: <ShieldCheck size={14} /> },
            ]}
          />
        }
      />

      {tab === 'register' && <DebtRegister />}
      {tab === 'covenants' && <CovenantsDashboard />}
    </>
  );
}
