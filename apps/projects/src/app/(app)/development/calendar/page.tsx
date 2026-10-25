import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { DevCalendar } from '@/components/development/DevCalendar';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Key dates' };
export const dynamic = 'force-dynamic';

/** Key dates and the covenant calendar (RED-06) across every SPE. */
export default async function KeyDatesPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Key dates', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Key dates" actions={<ButtonLink variant="quiet" href="/development">Development</ButtonLink>} />
        {!allowed ? <Denied what="Key dates" /> : (companyId ? <DevCalendar companyId={companyId} today={todayIso()} /> : <OneCompany what="Key dates" />)}
      </Page>
    </>
  );
}
