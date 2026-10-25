import type { ReactNode } from 'react';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope, type DealerScope } from '@/lib/pm/dealer/scope';
import { opsScope, type OpsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { guardPage } from '@/components/shell/page-guard';

/**
 * Server shells for the 1125 pages: the scope, the page guard, the context line and the "one
 * company" rule (writes go to one company), then the screen with its company id.
 */
export async function DealerShell({ title, what, actions, guard = '/stock', children }: {
  title: string; what: string; actions?: ReactNode;
  /** The page's own path for the page guard (lib/nav rules), so the rail and the guard agree. */
  guard?: string;
  children: (ctx: { companyId: string; o: DealerScope; today: string }) => ReactNode | Promise<ReactNode>;
}) {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage(guard);
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title={title} />
        <StoreOff title={title} what={what} />
      </Page>
    );
  }
  const companyId = o.writeCompanyId;
  return (
    <>
      <PageLine facts={[o.where, { label: title, strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title={title} actions={actions} />
        {companyId ? await children({ companyId, o, today: todayIso() }) : <OneCompany what={title} />}
      </Page>
    </>
  );
}

export async function MfgShell({ title, actions, guard = '/production', children }: {
  title: string; actions?: ReactNode; guard?: string;
  children: (ctx: { companyId: string; o: OpsScope; today: string }) => ReactNode | Promise<ReactNode>;
}) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage(guard);
  const companyId = o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null);
  return (
    <>
      <PageLine facts={[o.where, { label: title, strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title={title} actions={actions} />
        {companyId ? await children({ companyId, o, today: todayIso() }) : <OneCompany what={title} />}
      </Page>
    </>
  );
}
