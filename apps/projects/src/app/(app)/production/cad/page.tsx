import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { CadImportView } from '@/components/manufacturing/CadImportView';
import '@/components/ops/ops.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'CAD imports' };
export const dynamic = 'force-dynamic';

/** Cut lists from the design software, compared with the sold estimate, applied as the BOM. */
export default async function CadImportsPage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  return (
    <>
      <PageLine facts={[o.where, { label: 'CAD imports', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="CAD imports" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        <CadImportView jobs={jobRefs(o)} today={todayIso()} initialJob={searchParams.job && /^[0-9a-f-]{36}$/i.test(searchParams.job) ? searchParams.job : null} />
      </Page>
    </>
  );
}
