import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { can } from '@/lib/access/can';
import { buildLeadViews } from '@/lib/crm/build';
import { ContractNotLive, defaultPipeline, listLeads, listPipelines, ownerOptions } from '@/lib/crm/queries';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { LeadsView } from '@/components/crm/LeadsView';
import { CrmNotLive } from '@/components/crm/CrmNotLive';

export const metadata: Metadata = { title: 'Leads' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Leads (panel 06 BP-39..51): the board for a company's default pipeline, and the list with
 * saved filters across every company the caller holds projects.leads:view at.
 */
export default async function LeadsPage({ searchParams }: { searchParams: { company?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const { access, money: mv } = await guardPage('/leads');
  const db = await requireDb();
  const companyIds = scope.companyIds.filter((id) => can(access, 'projects.leads', 'view', id));
  const names = new Map(scope.tenant.companies.map((c) => [c.id, c.name]));
  const where = scope.company?.name ?? `${count(companyIds.length)} companies`;
  const picked = searchParams.company && UUID.test(searchParams.company) && companyIds.includes(searchParams.company) ? searchParams.company : null;
  const boardCompany = scope.company?.id ?? picked ?? (companyIds.length === 1 ? companyIds[0]! : null);

  let pipelines;
  let leads;
  try {
    [pipelines, leads] = await Promise.all([listPipelines(db, companyIds), listLeads(db, { companyIds })]);
  } catch (e) {
    if (e instanceof ContractNotLive) {
      return (
        <>
          <PageCrumbs items={[{ label: 'Leads' }]} />
          <PageLine facts={[where]} />
          <Page><PageHead eyebrow={where} title="Leads" /><CrmNotLive what="Leads" /></Page>
        </>
      );
    }
    throw e;
  }
  const now = Date.now();
  const today = todayIso();
  const [views, owners] = await Promise.all([
    buildLeadViews(db, leads, pipelines, access, scope.tenant.companies, { nowMs: now, today }),
    ownerOptions(db, companyIds, access.membershipId),
  ]);
  const pipeline = boardCompany ? defaultPipeline(pipelines, boardCompany) : null;
  const open = views.filter((l) => l.stageKind === 'open');
  const waiting = open.filter((l) => l.speed?.state === 'waiting').length;
  const due = open.reduce((s, l) => s + l.followupsDue, 0);
  const createCompanies = companyIds.filter((id) => can(access, 'projects.leads', 'create', id)).map((id) => ({ id, name: names.get(id) ?? 'Company' }));
  const showMoney = mv.contract;
  const openValue = open.reduce((s, l) => s + (l.amountCents ?? 0), 0);

  return (
    <>
      <PageCrumbs items={[{ label: 'Leads' }]} />
      <PageLine facts={[
        where,
        { label: showMoney ? `${count(open.length)} open · ${money(openValue, { decimals: 0 })}` : `${count(open.length)} open`, strong: true, tnum: true },
        ...(waiting ? [`${count(waiting)} waiting for a first touch`] : []),
        ...(due ? [`${count(due)} follow-ups due`] : []),
      ]} />
      <Page>
        <PageHead eyebrow={pipeline ? `${where} · ${pipeline.name}` : where} title="Leads"
          actions={!scope.company && companyIds.length > 1 ? (
            <div className="btn-row">
              {companyIds.map((id) => <ButtonLink key={id} variant={id === boardCompany ? 'primary' : 'quiet'} href={`/leads?company=${id}`}>Board: {names.get(id) ?? 'Company'}</ButtonLink>)}
            </div>
          ) : undefined}
        />
        <div className="density-cockpit">
          <LeadsView
            leads={views}
            pipeline={pipeline}
            pipelines={pipelines}
            me={access.membershipId}
            canCreate={createCompanies.length > 0}
            canEdit={boardCompany ? can(access, 'projects.leads', 'edit', boardCompany) : can(access, 'projects.leads', 'edit')}
            showMoney={showMoney}
            companies={createCompanies}
            defaultCompanyId={boardCompany && createCompanies.some((c) => c.id === boardCompany) ? boardCompany : createCompanies[0]?.id ?? null}
            owners={owners}
            readOnly={scope.readOnly}
          />
        </div>
      </Page>
    </>
  );
}
