import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getAccess } from '@/lib/access';
import { loadDelegations } from '@/lib/approvals/server';
import { PageLine } from '@/components/common/PageLine';
import { DelegationView } from '@/components/approvals/DelegationView';
import { PageCrumbs } from '@/components/shell/ShellContext';
import '@/components/approvals/approvals.css';

export const metadata: Metadata = { title: 'Out of office' };
export const dynamic = 'force-dynamic';

/** Delegation (BP-31): dates, a delegate, an optional dollar cap and object types. */
export default async function DelegationPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const [db, access] = await Promise.all([requireDb(), getAccess()]);
  const { mine, candidates } = await loadDelegations(db);
  const active = mine.outgoing.filter((d) => d.state === 'active').length;
  const canManage = access.grants.has('projects.settings:configure');
  return (
    <>
      <PageCrumbs items={[{ label: 'Approvals', href: '/approvals' }, { label: 'Out of office' }]} />
      <PageLine facts={[{ label: active ? `${count(active)} cover active` : 'No cover active', strong: true }, `${count(mine.incoming.filter((d) => d.state === 'active').length)} covering for others`]} />
      <Page>
        <PageHead eyebrow={['Approvals', 'Out of office']} title="Who covers my approvals" />
        <DelegationView mine={mine} candidates={candidates} canManage={canManage} readOnly={scope.readOnly} />
      </Page>
    </>
  );
}
