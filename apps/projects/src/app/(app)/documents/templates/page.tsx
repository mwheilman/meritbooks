import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { TEMPLATE_MONEY, TEMPLATE_SOURCE } from '@/lib/templates/loaders';
import { TEMPLATE_KEYS, type TemplateKey } from '@/lib/templates/types';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { DocsTabs } from '@/components/documents/DocsTabs';
import { TemplateGenerator, type TemplateOption } from '@/components/documents/TemplateGenerator';
import '@/components/ops/ops.css';
import '@/components/documents/documents.css';

export const metadata: Metadata = { title: 'Create a document' };
export const dynamic = 'force-dynamic';

const SIGNABLE: ReadonlySet<TemplateKey> = new Set(['proposal', 'contract', 'change_order', 'work_order', 'install_ticket', 'purchase_order', 'buyers_order', 'lien_waiver', 'pay_app_cover', 'draw_request', 'daily_report']);

export default async function TemplatesPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/documents');
  const jobs = jobRefs(o);
  const raw = typeof searchParams.job === 'string' ? searchParams.job : null;
  const jobId = raw && jobs.some((j) => j.id === raw) ? raw : null;
  const v = o.vocab;
  const LABEL: Record<TemplateKey, string> = {
    proposal: v.estimate === 'Estimate' ? 'Proposal' : v.estimate, contract: 'Contract', change_order: v.change_order, pay_app_cover: 'Pay application cover',
    work_order: v.work_order, daily_report: v.daily_log, install_ticket: 'Install ticket', purchase_order: 'Purchase order', buyers_order: "Buyer's order",
    draw_request: 'Draw request', lien_waiver: 'Lien waiver',
  };
  const templates: TemplateOption[] = TEMPLATE_KEYS.map((key) => ({
    key, label: LABEL[key], source: TEMPLATE_SOURCE[key], signable: SIGNABLE.has(key),
    allowed: can(access, 'projects.documents', 'create') && (!TEMPLATE_MONEY[key] || can(access, TEMPLATE_MONEY[key]!, 'view')),
  }));
  return (
    <>
      <PageLine facts={[o.where]} />
      <Page>
        <PageHead eyebrow={o.where} title="Create a document">Branded with your company&apos;s logo and colours, in your own terms, filed on the job as a new version.</PageHead>
        <DocsTabs active="templates" jobId={jobId} />
        <TemplateGenerator templates={templates} jobs={jobs} jobId={jobId} companyId={o.scope.company?.id ?? null} />
      </Page>
    </>
  );
}
