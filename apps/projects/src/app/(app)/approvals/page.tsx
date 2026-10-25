import type { Metadata } from 'next';
import Link from 'next/link';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getAccess } from '@/lib/access';
import { holds } from '@/lib/nav';
import { loadInbox } from '@/lib/approvals/server';
import { APPROVAL_TABS, type ApprovalTab } from '@/lib/approvals/types';
import { PageLine } from '@/components/common/PageLine';
import { ApprovalInbox } from '@/components/approvals/ApprovalInbox';
import '@/components/approvals/approvals.css';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

/**
 * Approvals (BP-30): one queue across change orders, commitments and their changes, billing,
 * draws, time, estimates below the floor, budget transfers, deal desking and gated stage moves.
 * Every signed-in member may open it: the database returns only the rows they may see.
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const [db, access] = await Promise.all([requireDb(), getAccess()]);
  const tab: ApprovalTab = (APPROVAL_TABS as readonly string[]).includes(searchParams.tab ?? '') ? (searchParams.tab as ApprovalTab) : 'mine';
  const cid = scope.company?.id ?? null;
  const showAll = holds(access, 'projects.settings:configure', cid) || access.group === 'management';
  const result = await loadInbox(db, { tab: tab === 'all' && !showAll ? 'mine' : tab, companyId: cid });
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  const overdue = result.counts.mine_overdue;
  return (
    <>
      <PageLine
        facts={[where, { label: `${count(result.counts.mine)} need you`, strong: true }, ...(overdue ? [`${count(overdue)} overdue`] : []), `${count(result.counts.waiting)} waiting on others`]}
        actions={
          <span className="t-cap">
            <Link className="link" href="/approvals/delegation">Out of office</Link>
            {holds(access, 'projects.settings:view', cid) && <> · <Link className="link" href="/approvals/policies">Approval rules</Link></>}
          </span>
        }
      />
      <Page>
        <PageHead eyebrow={['Approvals', where]} title={tab === 'waiting' ? 'Waiting on others' : tab === 'decided' ? 'Decided' : tab === 'all' ? 'All open approvals' : 'Needs my approval'} />
        <ApprovalInbox
          key={`${tab}:${cid ?? 'all'}`}
          tab={result.tab}
          items={result.items}
          counts={result.counts}
          showAll={showAll}
          readOnly={scope.readOnly}
          where={where}
        />
      </Page>
    </>
  );
}
