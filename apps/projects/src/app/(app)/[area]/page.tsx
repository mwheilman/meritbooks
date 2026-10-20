import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead, WidgetState } from '@meritbooks/merit-ui';
import { findArea } from '@/lib/areas';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { PageLine } from '@/components/common/PageLine';

export function generateMetadata({ params }: { params: { area: string } }): Metadata {
  return { title: findArea(params.area)?.title ?? 'Not found' };
}

/** Rail destinations whose module arrives in a later release: an honest page, no sample figures. */
export default async function AreaPage({ params }: { params: { area: string } }) {
  const area = findArea(params.area);
  if (!area) notFound();
  const scope = await pageScope();
  if (!scope) return null;
  const vocab = await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds);
  const title = area.vocab ? vocab[area.vocab] : area.title;
  return (
    <>
      <PageLine facts={[scope.company?.name ?? scope.tenant.orgName ?? 'Workspace', { label: 'Arrives in the next release', strong: true }]} />
      <Page>
        <PageHead eyebrow={scope.company?.name ?? 'Workspace'} title={title} />
        <div className="surface" style={{ maxWidth: 720 }}>
          <WidgetState
            state={{
              kind: 'empty',
              title: `${title} arrives in the next release`,
              body: `${area.what} Nothing here is live yet, so there is nothing to set up today.`,
              action: area.meanwhile ? <ButtonLink href={area.meanwhile.href}>{area.meanwhile.label}</ButtonLink> : <ButtonLink href="/jobs">Open {vocab.jobs.toLowerCase()}</ButtonLink>,
            }}
          />
        </div>
      </Page>
    </>
  );
}
