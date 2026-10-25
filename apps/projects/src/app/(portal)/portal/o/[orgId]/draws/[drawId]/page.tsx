import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { DrawReview } from '@/components/portal/DrawReview';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { date, money } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import { isUuid } from '@/lib/portal/tokens';
import type { PortalDraw } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/** Lender / payer draw review: lines against the loan budget, inspection, approve or return. */
export default async function PortalDrawPage({ params }: { params: { orgId: string; drawId: string } }) {
  const f = await orgFrame(params.orgId);
  const L = f.locale;
  const r = isUuid(params.drawId) ? await loadPortal<PortalDraw>('draw', { p_org: f.orgId, p_draw: params.drawId }) : null;
  const frame = (children: React.ReactNode) => (
    <PortalFrame locale={L} brand={f.brand} orgId={f.orgId} audiences={f.audiences} signedIn multiOrg={f.multiOrg}>{children}</PortalFrame>
  );
  if (!r || !r.ok) return frame(<InlineNotice tone="warn" title={t(L, 'err.not_found')} />);
  const d = r.data;
  return frame(
    <>
      <p className="pt-cap"><a href={`/portal/o/${f.orgId}/jobs/${d.job.id}`}>{d.job.name}</a> · {d.loan.lender}{d.loan.loan_number ? ` · ${d.loan.loan_number}` : ''}</p>
      <h1>{t(L, 'draw.title', { n: d.draw.number })}</h1>
      <div className="pt-sheet">
        <div className="pt-row"><span>{t(L, 'draw.period', { date: date(d.draw.period_end, L) })}</span><Status kind="track" pip="open">{d.draw.status}</Status></div>
        <div className="pt-row"><span>{t(L, 'impact.requested', { amount: '' }).trim()}</span><b className="n">{money(d.draw.requested_cents, L)}</b></div>
        <div className="pt-row"><span>{t(L, 'draw.loan')}</span><span className="n">{money(d.loan.commitment_cents, L)}</span></div>
        <div className="pt-row"><span>{t(L, 'draw.inspection')}</span><span className="n">{d.draw.inspection_status}{d.draw.inspector_pct !== null ? ` · ${Math.round(Number(d.draw.inspector_pct) * 100)}%` : ''}</span></div>
      </div>
      <DrawReview orgId={f.orgId} drawId={d.draw.id} lines={d.lines} locale={L} canDecide={d.can_decide && !d.decided} decided={d.decided}
                  verified={d.verified} phoneHint={f.phoneHint} company={f.company} />
    </>,
  );
}
