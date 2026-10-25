import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { InstallBoard } from '@/components/fieldservice/installs/InstallBoard';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { InstallBoardRow } from '@/lib/fieldservice/completion-types';
import { listEmployees } from '@/lib/pm/ops/field-queries';

export const metadata: Metadata = { title: 'Installs' };
export const dynamic = 'force-dynamic';

/** Install projects (FS-79 … FS-86): the stage board and each install end to end. */
export default async function InstallsPage() {
  const g = await fsPage([['projects.dispatch', 'view'], ['projects.jobs', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Installs" /><OneCompany what="Install projects" /></Page></>);
  const [board, vendors, employees, templates] = await Promise.all([
    rpcLoad<InstallBoardRow[]>(o.db, 'fs_install_board', { p_location: companyId }, []),
    o.db.schema('core').from('vendors').select('id, name').order('name').limit(500),
    listEmployees(o.db),
    o.db.schema('pm').from('fs_permit_templates').select('id, jurisdiction, permit_kind').eq('location_id', companyId).eq('is_active', true).order('jurisdiction'),
  ]);
  const company = o.companyName(companyId) ?? o.where;
  const stuck = board.data.filter((x) => x.stuck).length;
  const open = board.data.filter((x) => x.stage !== 'CLOSED').length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(open)} open installs`, strong: true }, ...(stuck ? [`${count(stuck)} stuck`] : [])]} />
      <Page>
        <PageHead eyebrow={company} title="Installs" />
        <InstallBoard projects={board.data} error={board.error}
          vendors={((vendors.data ?? []) as Array<{ id: string; name: string }>)}
          techs={employees.map((e) => ({ id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member' }))}
          permitTemplates={((templates.data ?? []) as Array<{ id: string; jurisdiction: string; permit_kind: string }>)}
          can={{ edit: g.can('projects.jobs', 'edit') || g.can('projects.dispatch', 'edit'), dispatch: g.can('projects.dispatch', 'edit'),
                 purchase: g.can('projects.commitments', 'create'), bill: g.can('projects.billing', 'create'), finance: g.can('projects.financials', 'view') }} />
      </Page>
    </>
  );
}
