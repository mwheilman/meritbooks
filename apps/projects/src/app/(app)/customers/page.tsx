import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { can } from '@/lib/access/can';
import { listCustomers, openDuplicateCount } from '@/lib/crm/customers';
import type { RelationshipStage } from '@/lib/crm/types';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { CustomersList } from '@/components/customers/CustomersList';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

const STAGES: ReadonlyArray<RelationshipStage> = ['prospect', 'customer', 'former'];

/** Customers on the shared master (panel 06 §2.4; SHARED-RECORDS §2). */
export default async function CustomersPage({ searchParams }: { searchParams: { q?: string; stage?: string; page?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/customers');
  const db = await requireDb();
  const q = (searchParams.q ?? '').slice(0, 80);
  const stage = STAGES.includes(searchParams.stage as RelationshipStage) ? (searchParams.stage as RelationshipStage) : null;
  const page = Math.max(1, Number(searchParams.page) || 1);
  const [list, duplicates] = await Promise.all([
    listCustomers(db, { q, stage, companyIds: scope.companyIds, page, perPage: 50 }, scope.tenant.companies),
    openDuplicateCount(db),
  ]);
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  const createCompanies = scope.companyIds.filter((id) => can(access, 'projects.customers', 'create', id));
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  return (
    <>
      <PageCrumbs items={[{ label: 'Customers' }]} />
      <PageLine facts={[where, { label: `${count(list.total)} ${q || stage ? 'matching' : 'customers'}`, strong: true, tnum: true }, ...(duplicates ? [`${count(duplicates)} possible duplicates`] : []), 'Shared with Merit Books']} />
      <Page>
        <PageHead eyebrow={where} title="Customers" />
        <div className="density-cockpit">
          <CustomersList
            rows={list.rows}
            total={list.total}
            page={list.page}
            perPage={list.perPage}
            q={q}
            stage={stage ?? 'all'}
            stagesUnavailable={list.stagesUnavailable}
            duplicates={duplicates}
            canCreate={createCompanies.length > 0}
            companies={createCompanies.map((id) => ({ id, name: names.get(id) ?? 'Company' }))}
            defaultCompanyId={scope.company?.id ?? null}
            showCompany={scope.companyIds.length > 1}
            readOnly={scope.readOnly}
          />
        </div>
      </Page>
    </>
  );
}
