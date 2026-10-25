import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { InboxView } from '@/components/design/InboxView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Vendor inbox' };
export const dynamic = 'force-dynamic';

/** Vendor email read by rules and matched to components; each change applied by a person. */
export default async function VendorInboxPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.selections', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Vendor inbox', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Vendor inbox" actions={<ButtonLink variant="quiet" href="/design">Design procurement</ButtonLink>} />
        {!allowed ? <Denied what="Vendor inbox" /> : (companyId ? <InboxView companyId={companyId} today={todayIso()} /> : <OneCompany what="Vendor inbox" />)}
      </Page>
    </>
  );
}
