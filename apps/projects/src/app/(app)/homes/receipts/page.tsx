import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { ReceiptsQueue } from '@/components/residential/ReceiptsQueue';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Receipts to code' };
export const dynamic = 'force-dynamic';

/** Receipts and card charges captured in the field (RES-62), coded to a cost code. */
export default async function ReceiptsToCodePage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  const cc = companyId && allowed ? await o.db.schema('pm').from('cost_codes').select('id, code, name').eq('location_id', companyId).is('job_id', null).eq('is_active', true).order('code').limit(2000) : { data: [] };
  const costCodes = (cc.data ?? []) as Array<{ id: string; code: string; name: string }>;
  return (
    <>
      <PageLine facts={[o.where, { label: 'Receipts to code', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Receipts to code" actions={<ButtonLink variant="quiet" href="/homes">Homes</ButtonLink>} />
        {!allowed ? <Denied what="Receipts to code" /> : (companyId ? <ReceiptsQueue companyId={companyId} today={todayIso()} costCodes={costCodes} /> : <OneCompany what="Receipts to code" />)}
      </Page>
    </>
  );
}
