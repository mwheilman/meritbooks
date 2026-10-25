import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadTemplates } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { TemplatesView } from '@/components/commercial/TemplatesView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Project templates' };

/** Project templates with global update (CGC-06). */
export default async function ProjectTemplatesPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/project-templates');
  const jobs = jobRefs(o);
  const { templates, applications } = await loadTemplates(o.db);
  const company = o.scope.company?.id ?? null;
  const inScope = templates.filter((t) => !t.location_id || o.companyIds.includes(t.location_id));
  return (
    <>
      <PageCrumbs items={[{ label: 'Settings', href: '/settings' }, { label: 'Project templates' }]} />
      <PageLine facts={[o.where, { label: `${count(inScope.filter((t) => t.is_active).length)} active templates`, strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Project templates" />
        <TemplatesView templates={inScope} applications={applications} jobs={jobs} companies={o.companies}
          canConfigure={holds(access, 'projects.settings:configure', company)} canApply={holds(access, 'projects.billing:edit', company)} />
      </Page>
    </>
  );
}
