/**
 * SSR smoke test for the dealer pieces that render without a live database: the RO pay-type
 * split, the store-off state and the four home widgets (first paint is their loading state).
 * merit-ui asserts banned state copy and hotkey conflicts while rendering.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { SplitSummary } from '@/components/dealer/service/RoLineEditor';
import { StoreOff, PickStoreNote } from '@/components/dealer/common/StoreOff';
import { AgedUnitsWidget, DealsToDeskWidget, PartsBelowMinWidget, RentalsOutWidget } from '@/components/dealer/widgets';
import { paySplit } from '@/lib/pm/dealer/math';
import type { Vocabulary } from '@/lib/pm/vocab';

const A = '11111111-1111-4111-8111-111111111111';
function wrap(el: ReactElement): string {
  const vocab = { ...DEFAULT_VOCAB, job: 'Repair order', jobs: 'Repair orders' } as Vocabulary;
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab, companies: [], activeCompanyId: A, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

describe('dealer views render', () => {
  it('the pay-type split shows only the payers on the repair order', () => {
    const split = paySplit([
      { kind: 'LABOR', pay_type: 'CUSTOMER', status: 'APPROVED', amount_cents: 25_000, qty: 2, unit_cost_cents: null, flag_hours: 2 },
      { kind: 'PART', pay_type: 'WARRANTY', status: 'APPROVED', amount_cents: 6_000, qty: 1, unit_cost_cents: 3_500, flag_hours: null },
    ]);
    const html = wrap(<SplitSummary split={split} />);
    expect(html).toContain('Who pays');
    expect(html).toContain('Customer');
    expect(html).toContain('Warranty');
    expect(html).not.toContain('Policy');
    expect(html).toContain('250.00');
    expect(wrap(<SplitSummary split={paySplit([])} />)).toBe(wrap(<></>));
  });

  it('store screens explain themselves to a company that is not a dealer', () => {
    const html = wrap(<StoreOff title="Stock" what="Units, cost and aging." />);
    expect(html).toContain('Stock is for equipment dealers');
    expect(wrap(<PickStoreNote what="Units" />)).toContain('Switch to one store');
  });

  it('the four home widgets paint their loading state first', () => {
    const html = wrap(<>{[<AgedUnitsWidget key="a" />, <DealsToDeskWidget key="d" />, <PartsBelowMinWidget key="p" />, <RentalsOutWidget key="r" />]}</>);
    expect(html).toContain('Units aging over 180 days');
    expect(html).toContain('Deals to desk');
    expect(html).toContain('Parts below minimum');
    expect(html).toContain('Rentals out');
  });
});
