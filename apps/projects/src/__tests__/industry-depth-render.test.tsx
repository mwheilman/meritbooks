/**
 * SSR smoke test for the 1122 industry-depth screens (dealer, manufacturing, flooring, design,
 * development). Every board's first paint is its loading state (the data comes from the route
 * after mount); merit-ui asserts banned state copy and hotkey conflicts while rendering.
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
import { PriceFilesView } from '@/components/dealer/parts/PriceFilesView';
import { CounterTools } from '@/components/dealer/parts/CounterTools';
import { ClaimBuilder } from '@/components/dealer/warranty/ClaimBuilder';
import { CreditsView } from '@/components/dealer/warranty/CreditsView';
import { TechBoard } from '@/components/dealer/service/TechBoard';
import { KpiBoard } from '@/components/dealer/stock/KpiBoard';
import { UnitTimeline } from '@/components/dealer/stock/UnitTimeline';
import { DeskWorksheet } from '@/components/dealer/deals/DeskWorksheet';
import { InspectionView } from '@/components/dealer/rentals/InspectionView';
import { ProgramsView } from '@/components/dealer/settings/ProgramsView';
import { Denied } from '@/components/dealer/common/Denied';
import { OneCompany, centsFrom, pctText, qty } from '@/components/dealer/common/depth';
import { CadImportView } from '@/components/manufacturing/CadImportView';
import { ReleaseView } from '@/components/manufacturing/ReleaseView';
import { BacklogView } from '@/components/manufacturing/BacklogView';
import { KioskView } from '@/components/manufacturing/KioskView';
import { RemakesView } from '@/components/manufacturing/RemakesView';
import { MaterialsView } from '@/components/manufacturing/MaterialsView';
import { InstallsView } from '@/components/manufacturing/InstallsView';
import { FlooringHome } from '@/components/flooring/FlooringHome';
import { FlooringJob } from '@/components/flooring/FlooringJob';
import { RollsView } from '@/components/flooring/RollsView';
import { PayView } from '@/components/flooring/PayView';
import { CatalogView } from '@/components/flooring/CatalogView';
import { DesignHub } from '@/components/design/DesignHub';
import { DesignProject } from '@/components/design/DesignProject';
import { InboxView } from '@/components/design/InboxView';
import { DevOverview } from '@/components/development/DevOverview';
import { DevProject } from '@/components/development/DevProject';
import { DrawView } from '@/components/development/DrawView';
import type { Vocabulary } from '@/lib/pm/vocab';
import type { JobOption } from '@/lib/pm/ops/scope';

const A = '11111111-1111-4111-8111-111111111111';
const J = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-25';
const jobs: JobOption[] = [{ id: J, label: 'J-1001 · Elm Street', companyId: A, company: null, customerId: null, customer: 'Avery Lane', open: true, jobTypeKey: 'default' }];

function wrap(el: ReactElement): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: DEFAULT_VOCAB as Vocabulary, companies: [], activeCompanyId: A, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

describe('dealer depth screens paint', () => {
  it.each([
    ['price files', <PriceFilesView key="a" companyId={A} today={T} />, 'Load a price file'],
    ['counter', <CounterTools key="b" companyId={A} today={T} />, 'Scan or key'],
    ['claim builder', <ClaimBuilder key="c" claimId={J} today={T} />, 'Loading the claim'],
    ['deadlines', <CreditsView key="d" companyId={A} today={T} />, 'Loading warranty deadlines'],
    ['tech board', <TechBoard key="e" companyId={A} today={T} />, 'Loading the tech board'],
    ['scorecard', <KpiBoard key="f" companyId={A} today={T} />, 'Loading the scorecard'],
    ['timeline', <UnitTimeline key="g" unitId={J} today={T} />, 'Loading the unit timeline'],
    ['desk', <DeskWorksheet key="h" dealId={J} />, 'Loading the deal desk'],
    ['inspection', <InspectionView key="i" contractId={J} today={T} />, 'Loading the inspection'],
    ['programs', <ProgramsView key="j" companyId={A} today={T} />, 'Finance programs'],
  ])('%s', (_n, el, text) => {
    expect(wrap(el)).toContain(text);
  });
  it('explains a missing grant and a missing company', () => {
    expect(wrap(<Denied what="Flooring" />)).toContain('Flooring is not part of your role here');
    expect(wrap(<OneCompany what="Price files" />)).toContain('Switch to one company');
  });
  it('reads dollars typed in a box exactly', () => {
    expect([centsFrom('1,234.5'), centsFrom('-3500000'), centsFrom('0.07'), centsFrom('1.234'), centsFrom('')]).toEqual([123450, -350000000, 7, null, null]);
    expect([qty(2), qty(2.5, 'SF'), pctText(0.1234), pctText(null)]).toEqual(['2', '2.5 SF', '12.3%', '—']);
  });
});

describe('manufacturing depth screens paint', () => {
  it.each([
    ['cad', <CadImportView key="a" jobs={jobs} today={T} initialJob={null} />, 'Pick a job'],
    ['release', <ReleaseView key="b" woId={J} />, 'Loading the release check'],
    ['backlog', <BacklogView key="c" companyId={A} today={T} />, 'Loading the backlog'],
    ['kiosk', <KioskView key="d" companyId={A} />, 'Scan your badge'],
    ['remakes', <RemakesView key="e" companyId={A} today={T} orders={[]} />, 'Ask for a remake'],
    ['materials', <MaterialsView key="f" companyId={A} today={T} jobs={jobs} />, 'Loading material demand'],
    ['installs', <InstallsView key="g" companyId={A} today={T} jobs={jobs} crews={[]} />, 'Book an install'],
  ])('%s', (_n, el, text) => {
    expect(wrap(el)).toContain(text);
  });
});

describe('flooring depth screens paint', () => {
  it.each([
    ['home', <FlooringHome key="a" companyId={A} today={T} jobs={jobs} />, 'Install capacity'],
    ['job', <FlooringJob key="b" jobId={J} companyId={A} today={T} />, 'Loading the job'],
    ['rolls', <RollsView key="c" companyId={A} today={T} />, 'Receive a roll'],
    ['pay', <PayView key="d" companyId={A} today={T} jobs={jobs} workers={[{ id: J, name: 'Sam Ortiz', type: '1099' }]} />, 'Pay a completed install'],
    ['catalog', <CatalogView key="e" companyId={A} crews={[]} />, 'Loading the catalog'],
  ])('%s', (_n, el, text) => {
    expect(wrap(el)).toContain(text);
  });
});

describe('design and development depth screens paint', () => {
  it.each([
    ['hub', <DesignHub key="a" companyId={A} today={T} jobs={jobs} />, 'Loading the procurement hub'],
    ['project', <DesignProject key="b" jobId={J} today={T} vendors={[]} contacts={[]} />, 'Loading the project'],
    ['inbox', <InboxView key="c" companyId={A} today={T} />, 'Paste a vendor email'],
    ['overview', <DevOverview key="d" companyId={A} today={T} />, 'Loading development projects'],
    ['dev project', <DevProject key="e" jobId={J} today={T} />, 'Loading the project'],
    ['draw', <DrawView key="f" drawId={J} today={T} vendors={[]} />, 'Loading the draw'],
  ])('%s', (_n, el, text) => {
    expect(wrap(el)).toContain(text);
  });
});
