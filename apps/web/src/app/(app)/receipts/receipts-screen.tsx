'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, PageHead, Tabs, money, useQuery } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useShellLine } from '@/components/layout/shell-context';
import { ChaseBoard } from './chase-board';
import { ReceiptsInbox } from './receipts-inbox';
import { CardholdersTab } from './cardholders-tab';
import { PolicyTab } from './policy-tab';
import type { ChaseResponse, ReceiptListResponse } from './receipts-types';

type Tab = 'chase' | 'inbox' | 'cardholders' | 'policy';
const TABS: readonly Tab[] = ['chase', 'inbox', 'cardholders', 'policy'];

/**
 * RECEIPTS — the bookkeeper's side of receipt capture & chase (FPB-workforce-app §15):
 *   Needs a receipt   outstanding card charges by cardholder, with the chase (remind now,
 *                     not required, reassign)
 *   Inbox             every captured receipt (Workforce, email, desk drag-drop), its read
 *                     and its match (confirm / pick / unmatch), batch "mark reviewed"
 *   Cardholders       card → person, manager, opt-out with approval
 *   Policy            the tenant / client switch (audited) and the receipt policy
 */
export function ReceiptsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get('tab') as Tab | null) ?? 'chase';
  const [tab, setTabState] = useState<Tab>(TABS.includes(initial) ? initial : 'chase');
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const { activeCompanyId, activeCompany, isAll } = useActiveCompany();
  const locationId = !isAll && activeCompanyId ? activeCompanyId : null;
  const companyName = activeCompany?.name ?? null;

  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      const sp = new URLSearchParams(Array.from(params.entries()));
      sp.set('tab', t);
      router.replace(`/receipts?${sp.toString()}`, { scroll: false });
    },
    [params, router],
  );
  const changed = useCallback(() => setRefreshKey((k) => k + 1), []);

  const { data: chase } = useQuery<ChaseResponse>('/api/receipts/chase', { location_id: locationId ?? undefined }, { key: `strip:${refreshKey}`, scope: false });
  const { data: inbox } = useQuery<ReceiptListResponse>('/api/receipts', { match: 'suggested', location_id: locationId ?? undefined, per_page: '1' }, { key: `inbox:${refreshKey}`, scope: false });
  const strip = chase?.strip;

  useShellLine(
    strip
      ? [
          { label: `${strip.outstanding.toLocaleString()} receipt${strip.outstanding === 1 ? '' : 's'} owed`, strong: strip.outstanding > 0 },
          `${money(strip.totalCents)} without a receipt`,
          strip.escalated ? `${strip.escalated} escalated` : 'Nothing escalated',
        ]
      : null,
    strip ? `${strip.outstanding}:${strip.escalated}:${strip.totalCents}` : 'none',
  );

  return (
    <div>
      <PageHead
        eyebrow={['Processing', 'Receipts']}
        title="Receipts"
        actions={
          <>
            <Button variant="quiet" icon="users" onClick={() => { setTab('cardholders'); setAddOpen(true); }} disabled={!locationId}>
              Add cardholder
            </Button>
            <Button variant="primary" icon="upload" onClick={() => setTab('inbox')}>
              Upload receipts
            </Button>
          </>
        }
      >
        <p className="t-cap">
          Who still owes a receipt for a card charge, what came in, and how it matched. Cardholders answer from the reminder link in Merit Workforce or by forwarding the e-receipt.
        </p>
      </PageHead>

      <Tabs<Tab>
        aria-label="Receipts"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'chase', label: 'Needs a receipt', count: strip?.outstanding || undefined },
          { value: 'inbox', label: 'Inbox', count: inbox?.counts.suggested || undefined },
          { value: 'cardholders', label: 'Cardholders' },
          { value: 'policy', label: 'Policy' },
        ]}
      />

      {tab === 'chase' && <ChaseBoard locationId={locationId} refreshKey={refreshKey} onChanged={changed} onAssignCardholder={() => { setTab('cardholders'); setAddOpen(true); }} />}
      {tab === 'inbox' && <ReceiptsInbox locationId={locationId} companyName={companyName} refreshKey={refreshKey} onChanged={changed} />}
      {tab === 'cardholders' && <CardholdersTab locationId={locationId} companyName={companyName} refreshKey={refreshKey} onChanged={changed} addOpen={addOpen} setAddOpen={setAddOpen} />}
      {tab === 'policy' && <PolicyTab locationId={locationId} companyName={companyName} onChanged={changed} />}
    </div>
  );
}
