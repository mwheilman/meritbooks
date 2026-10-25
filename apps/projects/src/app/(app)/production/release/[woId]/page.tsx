import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ReleaseView } from '@/components/manufacturing/ReleaseView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Release to shop' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every gate a production order must pass before it reaches the shop floor. */
export default async function ReleaseToShopPage({ params }: { params: { woId: string } }) {
  if (!UUID.test(params.woId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  return (
    <>
      <PageLine facts={[o.where, { label: 'Release to shop', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Release to shop" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        <ReleaseView woId={params.woId} />
      </Page>
    </>
  );
}
