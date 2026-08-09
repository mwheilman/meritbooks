'use client';

import { PageHeader } from '@/components/ui';
import { Landmark, CreditCard, Banknote } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { BankFeedContent } from './bank-feed-content';
import { CreditCardFeed } from '../credit-cards/credit-card-feed';
import { ApplyDepositsQueue } from '../cash-application/cash-application-parts';

const TABS = ['feed', 'credit-cards', 'apply-deposits'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  feed: 'AI-categorized bank transactions awaiting review',
  'credit-cards': 'Card transaction matching with receipt chase tracking',
  'apply-deposits': 'Match incoming deposits to open invoices and post the receipt',
};

export function BankFeedTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'feed');

  return (
    <>
      <PageHeader
        title="Bank Feed"
        description={DESCRIPTIONS[tab]}
        actions={
          <SectionTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'feed', label: 'Bank Feed', icon: <Landmark size={14} /> },
              { id: 'credit-cards', label: 'Credit Cards', icon: <CreditCard size={14} /> },
              { id: 'apply-deposits', label: 'Apply Deposits', icon: <Banknote size={14} /> },
            ]}
          />
        }
      />

      {tab === 'feed' && <BankFeedContent />}
      {tab === 'credit-cards' && <CreditCardFeed />}
      {tab === 'apply-deposits' && <ApplyDepositsQueue />}
    </>
  );
}
