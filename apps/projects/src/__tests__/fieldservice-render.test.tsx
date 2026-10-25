/**
 * SSR smoke test for the field-service screens (1117): each renders with realistic rows, in the
 * shell, without throwing (merit-ui asserts banned state copy and hotkey conflicts in dev).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/calls',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { CapacityGrid } from '@/components/fieldservice/capacity/CapacityGrid';
import { CallDesk } from '@/components/fieldservice/calls/CallDesk';
import { PricebookManager } from '@/components/fieldservice/pricebook/PricebookManager';
import { AgreementsWorkspace } from '@/components/fieldservice/agreements/AgreementsWorkspace';
import { VisitWorkspace } from '@/components/fieldservice/options/VisitWorkspace';
import { DispatchFieldStrip } from '@/components/fieldservice/dispatch/DispatchFieldStrip';
import type { BookingSetup, PricebookData, VisitData } from '@/lib/fieldservice/queries';
import type { CapacityCell, WindowRow } from '@/lib/fieldservice/types';
import type { Vocabulary } from '@/lib/pm/vocab';

const L = '11111111-1111-4111-8111-111111111111';
const BU = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const DAY = '2026-10-27';

function wrap(el: ReactElement): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: DEFAULT_VOCAB as Vocabulary, companies: [], activeCompanyId: L, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const windows: WindowRow[] = [{ id: W, location_id: L, label: '8–10 am', start_time: '08:00:00', end_time: '10:00:00', days_of_week: [1, 2, 3, 4, 5], is_after_hours: false, online: true, sort: 1, is_active: true }];
const cells: CapacityCell[] = [{ service_day: DAY, business_unit_id: BU, arrival_window_id: W, window_label: '8–10 am', start_time: '08:00:00', end_time: '10:00:00', is_after_hours: false, limited: true, max_jobs: 2, max_minutes: null, used_jobs: 2, used_minutes: 180, jobs_left: 0, minutes_left: null, is_open: false }];
const setup: BookingSetup = {
  businessUnits: [{ id: BU, location_id: L, code: 'HVAC_SVC', name: 'HVAC Service', trade: 'HVAC', kind: 'SERVICE', is_active: true, sort: 1 }],
  zones: [], windows, campaigns: [], templates: [],
  jobTypes: [{ id: '44444444-4444-4444-8444-444444444444', location_id: L, key: 'no_cool', label: 'No Cool', business_unit_id: BU, work_order_kind: 'SERVICE', default_priority: 2, estimated_minutes: 90, required_skills: [], diagnostic_fee_cents: 8900, after_hours_fee_cents: 9900, member_waives_diagnostic: true, is_recall: false, online: true, script: { questions: [{ id: 'age', prompt: 'How old?', kind: 'text', required: true }] }, is_active: true, sort: 1 }],
};

describe('field-service screens render', () => {
  it('capacity grid says Full in words', () => {
    const html = wrap(<CapacityGrid cells={cells} windows={windows} businessUnitId={BU} days={[DAY]} today={DAY} onPick={() => {}} />);
    expect(html).toContain('Full');
    expect(html).toContain('2 of 2 booked');
  });
  it('call desk, empty pop and requests inbox', () => {
    const html = wrap(<CallDesk companyId={L} companyName="Heartland" today={DAY} setup={setup} recent={[]} requests={[]} canOverride />);
    expect(html).toContain('01 // Caller');
    expect(html).toContain('No waiting requests');
  });
  it('price book: first-run starter and a populated grid without cost', () => {
    const empty: PricebookData = { items: [], categories: [], businessUnits: [], settings: null, tiers: [], bundles: [], plans: [], capped: false };
    expect(wrap(<PricebookManager companyId={L} data={empty} seesCost={false} canEdit={false} canSeed />)).toContain('Load the starter setup');
    const data: PricebookData = { ...empty, items: [{ id: 'i1', location_id: L, code: 'HV-CAP', name: 'Replace run capacitor', unit: 'EA', kind: 'SERVICE', category_id: null, business_unit_id: null, task_hours: 0.75, target_gm_pct: null, price_locked: false, price_cents: 20900, member_price_cents: 17900, after_hours_price_cents: 31900, cost_cents: null, material_cost_cents: null, labor_cost_cents: null, customer_description: null, gbb_tier: 'GOOD', is_active: true, priced_at: null }] };
    const html = wrap(<PricebookManager companyId={L} data={data} seesCost={false} canEdit={false} canSeed={false} />);
    expect(html).toContain('209.00');
    expect(html).not.toContain('Margin');
  });
  it('agreements workspace and the dispatch strip', () => {
    const html = wrap(<AgreementsWorkspace companyId={L} today={DAY} data={{ visitsDue: [], renewals: [], deferred: [], schedule: [], templates: [], imports: [] }} customers={{}} techs={{}} zones={[]} windows={windows} businessUnits={setup.businessUnits} jobTypeKeys={['build']} can={{ dispatch: true, bill: true, finance: true, importer: true, renew: true, contract: true }} />);
    expect(html).toContain('Visits due');
    expect(wrap(<DispatchFieldStrip cells={cells} businessUnits={setup.businessUnits} windows={windows} onCall={[]} events={[]} employees={{}} day={DAY} />)).toContain('Full');
  });
  it('visit workspace with no options yet', () => {
    const data: VisitData = {
      brief: { phone: null, matches: [], tracking_campaign: null, is_member: true, equipment: [], agreements: [], work_order: { id: 'w', number: 'WO-1', summary: 'No cool', complaint: 'Warm air', kind: 'SERVICE', service_day: DAY, requested_start: null, requested_end: null, is_callback: false, site_id: null, asset_id: null }, site: null, call: null },
      estimates: [], options: [], items: [], totals: [], pricebook: [], plans: [], templates: [], eligible: [],
    };
    const html = wrap(<VisitWorkspace workOrderId="w" today={DAY} data={data} showEligible={false} canRequestDeposit={false} seesCost={false} />);
    expect(html).toContain('Before you go in');
    expect(html).toContain('Member');
  });
});
