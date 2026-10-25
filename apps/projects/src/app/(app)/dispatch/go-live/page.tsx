import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { GoLive } from '@/components/fieldservice/setup/GoLive';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { SetupStatus, ShadowReport } from '@/lib/fieldservice/completion-types';
import { todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Go-live' };
export const dynamic = 'force-dynamic';

/** Guided setup and the shadow-run comparison report (FS-117). */
export default async function GoLivePage() {
  const g = await fsPage([['projects.settings', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Go-live" /><OneCompany what="Field-service setup" /></Page></>);
  const [status, shadow] = await Promise.all([
    rpcLoad<SetupStatus>(o.db, 'fs_setup_status', { p_location: companyId }, { steps: [], done: 0, total: 0 }),
    rpcLoad<ShadowReport>(o.db, 'fs_shadow_report', { p_location: companyId, p_from: null, p_to: null }, { days: [], matched_days: 0 }),
  ]);
  const company = o.companyName(companyId) ?? o.where;
  return (
    <>
      <PageLine facts={[company, { label: `${count(status.data.done)} of ${count(status.data.total)} set up`, strong: true },
        `${count(shadow.data.matched_days)} of ${count(shadow.data.days.length)} shadow days match`]} />
      <Page>
        <PageHead eyebrow={company} title="Go-live" />
        <GoLive companyId={companyId} status={status.data} statusError={status.error} shadow={shadow.data} shadowError={shadow.error} today={todayIso()}
          canConfigure={g.can('projects.settings', 'configure')} canRecord={g.can('projects.settings', 'view')} />
      </Page>
    </>
  );
}
