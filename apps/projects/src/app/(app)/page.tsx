import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getMe, homeDensityFor } from '@/lib/pm/people';
import { loadHome } from '@/lib/pm/home';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { lower } from '@/lib/pm/vocab';
import { PageLine } from '@/components/common/PageLine';
import { HomeViewToggle } from '@/components/home/HomeViewToggle';
import { PmHome } from '@/components/home/PmHome';
import { OwnerHome } from '@/components/home/OwnerHome';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage({ searchParams }: { searchParams: { view?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const moduleIds = scope.company ? [scope.company.id] : scope.companyIds;
  const [me, data, vocab, modules] = await Promise.all([
    getMe(db, scope.userId), loadHome(db, scope), getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    getModulesFor(db, moduleIds, scope.installs),
  ]);
  const view = searchParams.view === 'report' || searchParams.view === 'cockpit' ? searchParams.view : homeDensityFor(me.role);
  const where = scope.company?.name ?? (scope.view === 'consolidated' ? `${scope.tenant.orgName ?? 'Workspace'}, consolidated` : `${count(scope.installedCompanies.length)} companies`);
  const fact = data.needs.length
    ? { label: `${count(data.needs.length)} need you`, strong: true }
    : { label: `${count(data.openJobCount)} open ${lower(vocab.jobs)}`, strong: true };

  return (
    <>
      <PageLine facts={[where, fact, ...(data.overdueCount ? [`${count(data.overdueCount)} tasks overdue`] : [])]} />
      <Page>
        <PageHead eyebrow={where} title="Home" actions={<HomeViewToggle value={view} />} />
        {view === 'report' ? (
          <div className="density-report">
            <OwnerHome data={data} />
          </div>
        ) : (
          <div className="density-cockpit">
            <PmHome data={data} readOnly={scope.readOnly} modules={modules} />
          </div>
        )}
      </Page>
    </>
  );
}
