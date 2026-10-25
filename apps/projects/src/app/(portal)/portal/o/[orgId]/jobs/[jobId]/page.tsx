import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { DocList, DrawList, Household, LogList, MilestoneList, PhotoGrid, RequestList } from '@/components/portal/JobSections';
import { MessageThread } from '@/components/portal/MessageThread';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { RequestForm } from '@/components/portal/RequestForm';
import { AssignmentActions, PunchDone } from '@/components/portal/VendorActions';
import { date, money } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import { isUuid } from '@/lib/portal/tokens';
import type { PortalJob } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/** One project as this person may see it: customer, sub, lender / investor sections. */
export default async function PortalJobPage({ params }: { params: { orgId: string; jobId: string } }) {
  const f = await orgFrame(params.orgId);
  const L = f.locale;
  const r = isUuid(params.jobId) ? await loadPortal<PortalJob>('job', { p_org: f.orgId, p_job: params.jobId }) : null;
  const frame = (children: React.ReactNode) => (
    <PortalFrame locale={L} brand={r?.ok ? r.data.brand ?? f.brand : f.brand} orgId={f.orgId} audiences={f.audiences} signedIn multiOrg={f.multiOrg}>{children}</PortalFrame>
  );
  if (!r || !r.ok) return frame(<InlineNotice tone="warn" title={t(L, 'err.not_found')} />);
  const j = r.data;
  const isCustomer = j.audiences.includes('customer');
  const isVendor = j.audiences.includes('vendor');
  const lenderish = j.audiences.find((a) => a === 'lender' || a === 'investor');
  const threadAudience = isCustomer ? 'customer' : isVendor ? 'vendor' : lenderish ?? null;
  return frame(
    <>
      <p className="pt-cap">{j.job.company} · {j.job.number}</p>
      <h1>{j.job.name}</h1>

      {(isCustomer || lenderish) && (
        <section aria-labelledby="sch"><h2 id="sch">{t(L, 'job.schedule')}</h2><MilestoneList items={j.milestones ?? []} locale={L} /></section>
      )}
      {isVendor && (
        <section aria-labelledby="asg">
          <h2 id="asg">{t(L, 'job.assignments')}</h2>
          {(j.assignments ?? []).length === 0 ? <p className="pt-empty">{t(L, 'work.no_work')}</p> : (
            <ul className="pt-list">
              {(j.assignments ?? []).map((a) => (
                <li key={a.id}>
                  <div className="pt-row"><b>{a.title}</b><span className="pt-cap">{date(a.start, L)}{a.finish ? ` – ${date(a.finish, L)}` : ''}</span></div>
                  {a.status !== 'DONE' && <AssignmentActions orgId={f.orgId} taskId={a.id} response={a.response} locale={L} />}
                </li>
              ))}
            </ul>
          )}
          {(j.commitments ?? []).length > 0 && (
            <>
              <h2>{t(L, 'job.contracts')}</h2>
              <ul className="pt-list">
                {(j.commitments ?? []).map((c) => (
                  <li key={c.id} className="pt-row">
                    <a href={`/portal/o/${f.orgId}/items/commitment/${c.id}`}>{c.number}{c.title ? ` · ${c.title}` : ''}</a>
                    <Status kind={c.status === 'APPROVED' ? 'risk' : 'ready'} pip={c.status === 'APPROVED' ? 'open' : 'closed'}>{c.status}</Status>
                    <span className="n">{money(c.amount_cents, L)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(j.punch ?? []).length > 0 && (
            <>
              <h2>{t(L, 'job.punch')}</h2>
              <ul className="pt-list">
                {(j.punch ?? []).map((p) => (
                  <li key={p.id}>
                    <div className="pt-row"><b>{p.title}</b><span className="pt-cap">{p.area ?? ''} {p.due_on ? `· ${date(p.due_on, L)}` : ''}</span></div>
                    {['OPEN', 'IN_PROGRESS'].includes(p.status) ? <PunchDone orgId={f.orgId} itemId={p.id} locale={L} /> : <p className="pt-cap">{p.status}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(j.vendor_documents ?? []).length > 0 && (
            <><h2>{t(L, 'job.documents')}</h2><DocList orgId={f.orgId} docs={j.vendor_documents ?? []} locale={L} /></>
          )}
        </section>
      )}
      {(j.draws ?? []).length > 0 && (
        <section aria-labelledby="drw"><h2 id="drw">{t(L, 'job.draws')}</h2><DrawList orgId={f.orgId} draws={j.draws ?? []} locale={L} /></section>
      )}
      {isCustomer && (
        <>
          <section aria-labelledby="ph"><h2 id="ph">{t(L, 'job.photos')}</h2><PhotoGrid orgId={f.orgId} photos={j.photos ?? []} locale={L} /></section>
          <section aria-labelledby="up"><h2 id="up">{t(L, 'job.updates')}</h2><LogList logs={j.logs ?? []} locale={L} /></section>
        </>
      )}
      {(isCustomer || lenderish) && (
        <section aria-labelledby="doc"><h2 id="doc">{t(L, 'job.documents')}</h2><DocList orgId={f.orgId} docs={j.documents ?? []} locale={L} /></section>
      )}
      {threadAudience && (
        <section aria-labelledby="msg"><h2 id="msg">{t(L, 'job.messages')}</h2><MessageThread orgId={f.orgId} jobId={j.job.id} audience={threadAudience} locale={L} /></section>
      )}
      {isCustomer && (
        <>
          <section aria-labelledby="req">
            <h2 id="req">{t(L, 'job.requests')}</h2>
            <RequestList rows={j.requests ?? []} locale={L} />
            <div className="pt-sheet" style={{ marginTop: 8 }}><RequestForm orgId={f.orgId} jobId={j.job.id} locale={L} /></div>
          </section>
          {(j.household ?? []).length > 0 && (
            <section aria-labelledby="hh"><h2 id="hh">{t(L, 'job.household')}</h2><Household people={j.household ?? []} locale={L} /></section>
          )}
        </>
      )}
    </>,
  );
}
