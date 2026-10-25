import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { PayView } from '@/components/flooring/PayView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import type { Worker } from '@/components/flooring/PayView';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Installer pay' };
export const dynamic = 'force-dynamic';

/** Piece-rate pay tickets from completions, splits, chargebacks; W-2 to payroll, 1099 to payables. */
export default async function InstallerPayPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.time', 'view', companyId);
  const [emps, vens] = companyId ? await Promise.all([o.db.schema('core').from('employees').select('id, first_name, last_name').eq('is_active', true).order('last_name').limit(500), o.db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true).order('name').limit(500)]) : [null, null];
  const workers: Worker[] = [...((emps?.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>).map((e) => ({ id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Employee', type: 'W2' as const })), ...((vens?.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name, type: '1099' as const }))];
  return (
    <>
      <PageLine facts={[o.where, { label: 'Installer pay', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Installer pay" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Installer pay" /> : (companyId ? <PayView companyId={companyId} today={todayIso()} jobs={jobRefs(o).filter((j) => j.companyId === companyId)} workers={workers} /> : <OneCompany what="Installer pay" />)}
      </Page>
    </>
  );
}
