import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { PricebookManager } from '@/components/fieldservice/pricebook/PricebookManager';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadPricebook } from '@/lib/fieldservice/queries';

export const metadata: Metadata = { title: 'Price book' };
export const dynamic = 'force-dynamic';

/** Flat-rate price book (FS-44–47). Any Projects member reads sell prices; cost and the formula need job financials. */
export default async function PricebookPage() {
  const g = await fsPage([['projects.settings', 'view'], ['projects.dispatch', 'view'], ['projects.estimates', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Price book" /><OneCompany what="Price books" /></Page></>);
  const data = await loadPricebook(o.db, companyId);
  const company = o.companyName(companyId) ?? o.where;
  const tasks = data.items.filter((i) => i.kind === 'SERVICE' && i.is_active).length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(data.items.length)} items`, strong: true }, `${count(tasks)} flat-rate tasks`]} />
      <Page>
        <PageHead eyebrow={company} title="Price book" />
        <PricebookManager
          companyId={companyId}
          data={data}
          seesCost={g.can('projects.financials', 'view')}
          canEdit={g.can('projects.settings', 'configure') || g.can('projects.financials', 'edit')}
          canSeed={g.can('projects.settings', 'configure')}
        />
      </Page>
    </>
  );
}
