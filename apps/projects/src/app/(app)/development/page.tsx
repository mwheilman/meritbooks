import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { DevOverview } from '@/components/development/DevOverview';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Development' };
export const dynamic = 'force-dynamic';

/** Every development project you reach with job financials: in balance, contingency, dates, capital needs. */
export default async function DevelopmentPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const allowed = can(access, 'projects.financials', 'view', o.scope.company?.id ?? null);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Development', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Development" />
        {!allowed ? <Denied what="Development" /> : <><DevOverview companyId={o.scope.company?.id ?? null} today={todayIso()} /></>}
      </Page>
    </>
  );
}
