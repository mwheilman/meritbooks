import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { FormTemplates } from '@/components/fieldservice/forms/FormTemplates';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadFormTemplates } from '@/lib/fieldservice/completion';

export const metadata: Metadata = { title: 'Checklists and forms' };
export const dynamic = 'force-dynamic';

/** Checklists and forms with required readings (FS-29). */
export default async function FormsPage() {
  const g = await fsPage([['projects.jobs', 'view'], ['projects.settings', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Checklists and forms" /><OneCompany what="Checklists and forms" /></Page></>);
  const t = await loadFormTemplates(o.db, companyId);
  const company = o.companyName(companyId) ?? o.where;
  return (
    <>
      <PageLine facts={[company, { label: `${count(t.data.filter((x) => x.is_active).length)} active`, strong: true }, `${count(t.data.length)} forms`]} />
      <Page>
        <PageHead eyebrow={company} title="Checklists and forms" />
        <FormTemplates templates={t.data} error={t.error} canEdit={g.can('projects.settings', 'configure')} />
      </Page>
    </>
  );
}
