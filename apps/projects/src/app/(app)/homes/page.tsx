import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { loadBuilder } from '@/lib/residential/queries';
import { resPage } from '@/lib/residential/page';
import { PageLine } from '@/components/common/PageLine';
import { BuilderBoard } from '@/components/residential/BuilderBoard';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Homes' };

export default async function HomesPage() {
  const g = await resPage('/homes', 'projects.jobs', 'view');
  if (!g) return null;
  const { o } = g;
  const b = await loadBuilder(o.db, o.companyIds);
  const started = b.lots.filter((l) => l.status === 'STARTED');
  const behind = started.filter((l) => l.behind_standard).length;
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(started.length)} under construction`, strong: true }, ...(behind ? [`${count(behind)} behind the standard cycle`] : []), `${count(b.specs.length)} specs for sale`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Homes">
          <p className="t-cap" style={{ marginTop: 4 }}>Every lot by community: sold and under construction against the plan’s standard cycle, and spec inventory with days on market. Open a lot to quote, write the purchase agreement, change options at the design center and release the start package.</p>
        </PageHead>
        <BuilderBoard bundle={b} />
      </Page>
    </>
  );
}
