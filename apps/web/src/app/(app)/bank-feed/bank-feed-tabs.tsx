'use client';

import { PageHeader } from '@/components/ui';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { BankFeedContent } from './bank-feed-content';
import { CreditCardFeed } from '../credit-cards/credit-card-feed';
import { ApplyDepositsQueue } from '../cash-application/cash-application-parts';

const TABS = ['feed', 'credit-cards', 'apply-deposits'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  feed: 'Bank lines the AI has coded, lowest confidence first. Nothing posts until you approve it.',
  'credit-cards': 'Card charges matched to receipts, with the receipt chase for each cardholder.',
  'apply-deposits': 'Match incoming deposits to open invoices, then approve to post the receipt.',
};

export function BankFeedTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'feed');

  return (
    <>
      <PageHeader title="Bank feed" eyebrow={['Banking & cash', 'Bank feed']} description={DESCRIPTIONS[tab]} />

      <SectionTabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'feed', label: 'Bank feed' },
          { id: 'credit-cards', label: 'Credit cards' },
          { id: 'apply-deposits', label: 'Apply deposits' },
        ]}
      />

      {tab === 'feed' && <BankFeedContent />}
      {tab === 'credit-cards' && <CreditCardFeed />}
      {tab === 'apply-deposits' && <ApplyDepositsQueue />}
    </>
  );
}
