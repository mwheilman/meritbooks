import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { AppointmentsBoard } from '@/components/residential/AppointmentsBoard';
import { APP_TZ } from '@/lib/time';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

/** In-home appointments (RES-10): booking by rep and drive time, reminders, the public booking link. */
export default async function AppointmentsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Appointments', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Appointments" actions={<ButtonLink variant="quiet" href="/homes">Homes</ButtonLink>} />
        {!allowed ? <Denied what="Appointments" /> : (companyId ? <AppointmentsBoard companyId={companyId} timeZone={APP_TZ} /> : <OneCompany what="Appointments" />)}
      </Page>
    </>
  );
}
