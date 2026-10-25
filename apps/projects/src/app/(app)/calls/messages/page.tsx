import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { MessageCenter } from '@/components/fieldservice/messages/MessageCenter';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadMessageTemplates, loadThreads, nameMap } from '@/lib/fieldservice/completion';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

/** Two-way customer texts and email (FS-12), with reminder replies filed on the thread (FS-22). */
export default async function MessagesPage({ searchParams }: { searchParams: { thread?: string; status?: string } }) {
  const g = await fsPage([['projects.dispatch', 'view'], ['projects.customers', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Messages" /><OneCompany what="Customer conversations" /></Page></>);
  const status = searchParams.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const [threads, templates] = await Promise.all([loadThreads(o.db, companyId, status), loadMessageTemplates(o.db, companyId)]);
  const customers = await nameMap(o.db, 'customers', threads.data.map((t) => t.customer_id));
  const unread = threads.data.filter((t) => t.unread_count > 0).length;
  const company = o.companyName(companyId) ?? o.where;
  return (
    <>
      <PageLine facts={[company, { label: `${count(threads.data.length)} ${status === 'OPEN' ? 'open' : 'closed'}`, strong: true }, ...(unread ? [`${count(unread)} unread`] : [])]} />
      <Page>
        <PageHead eyebrow={company} title="Messages" />
        <MessageCenter companyId={companyId} threads={threads.data} error={threads.error} templates={templates.data} customers={customers}
          initialThread={searchParams.thread ?? null} status={status} canSend={g.can('projects.dispatch', 'edit') || g.can('projects.customers', 'edit')} />
      </Page>
    </>
  );
}
