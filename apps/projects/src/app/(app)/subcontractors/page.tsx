import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { scopedJobs } from '@/lib/pm/scoped';
import { todayIso } from '@/lib/time';
import { scopedCommitments } from '@/lib/pm/money/scoped';
import { listComplianceForVendors } from '@/lib/pm/money/queries';
import { complianceMark } from '@/lib/pm/money/status';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { SubcontractorsView, type VendorRowView } from '@/components/money/SubcontractorsView';
import { guardPage } from '@/components/shell/page-guard';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Subcontractors' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).subcontractors };
}

/** Vendors with commitments in scope, their compliance documents (pm.compliance_docs) and what expires soon. */
export default async function SubcontractorsPage() {
  const scope = await pageScope();
  if (!scope) return null;
  await guardPage('/subcontractors');
  const db = await requireDb();
  const [vocab, jobs, commitments] = await Promise.all([
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
    scopedJobs(db, scope),
    scopedCommitments(db, scope, ['DRAFT', 'APPROVED', 'EXECUTED']),
  ]);
  const withVendor = commitments.filter((c) => c.vendorId);
  const docs = await listComplianceForVendors(db, withVendor.map((c) => c.vendorId!));
  const numberOf = new Map(commitments.map((c) => [c.id, c.number]));
  const map = new Map<string, VendorRowView>();
  for (const c of withVendor) {
    const v = map.get(c.vendorId!) ?? { id: c.vendorId!, name: c.vendorName ?? 'Vendor', commitments: [], docs: [] };
    v.commitments.push({ id: c.id, number: c.number, jobId: c.jobId, jobLabel: c.jobLabel, status: c.status, committed: c.t.committed, open: c.t.open, billed: c.t.billed, held: (c.status === 'APPROVED' || c.status === 'EXECUTED') && c.t.holdEffective });
    map.set(c.vendorId!, v);
  }
  for (const d of docs) {
    if (!d.vendor_id || !map.has(d.vendor_id) || !jobs.byId.has(d.job_id)) continue;
    map.get(d.vendor_id)!.docs.push({ ...d, jobLabel: jobs.label(d.job_id) ?? 'Job', commitmentNumber: d.commitment_id ? numberOf.get(d.commitment_id) ?? null : null });
  }
  const vendors = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  const today = todayIso();
  const lapsed = vendors.filter((v) => v.docs.some((d) => d.required && !complianceMark(d, today).ok)).length;
  const soon = vendors.filter((v) => v.docs.some((d) => complianceMark(d, today).expiringSoon)).length;
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageCrumbs items={[{ label: vocab.subcontractors }]} />
      <PageLine facts={[where, { label: `${count(lapsed)} with documents not current`, strong: lapsed > 0 }, `${count(soon)} expiring in 30 days`, `${count(vendors.length)} vendors`]} />
      <Page>
        <PageHead eyebrow={where} title={vocab.subcontractors}>
          <p className="t-cap" style={{ marginTop: 4 }}>Vendors come from Merit Books. Documents are kept on each commitment’s Compliance tab.</p>
        </PageHead>
        <SubcontractorsView vendors={vendors} today={today} companyId={scope.company?.id ?? null} />
      </Page>
    </>
  );
}
