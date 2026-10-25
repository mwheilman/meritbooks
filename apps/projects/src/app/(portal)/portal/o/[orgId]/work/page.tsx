import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { AssignmentActions, ComplianceUpload } from '@/components/portal/VendorActions';
import { date, money } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import type { PortalVendor } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/** A sub's work at this company: six-week look-ahead, payments from Books AP, insurance and tax forms. */
export default async function PortalWorkPage({ params }: { params: { orgId: string } }) {
  const f = await orgFrame(params.orgId);
  const L = f.locale;
  const r = await loadPortal<PortalVendor>('vendor', { p_org: f.orgId });
  return (
    <PortalFrame locale={L} brand={f.brand} orgId={f.orgId} audiences={f.audiences} active="work" signedIn multiOrg={f.multiOrg}>
      <h1>{t(L, 'work.title')}</h1>
      {!r.ok ? <InlineNotice tone="warn" title={t(L, 'err.not_found')} /> : (
        <>
          <section aria-labelledby="la">
            <h2 id="la">{t(L, 'work.lookahead')}</h2>
            {r.data.lookahead.length === 0 ? <p className="pt-empty">{t(L, 'work.no_work')}</p> : (
              <ul className="pt-list">
                {r.data.lookahead.map((a) => (
                  <li key={a.id}>
                    <div className="pt-row"><b>{a.title}</b><span className="pt-cap">{date(a.start, L)}{a.finish ? ` – ${date(a.finish, L)}` : ''}</span></div>
                    <p className="pt-cap"><a href={`/portal/o/${f.orgId}/jobs/${a.job.id}`}>{a.job.name}</a></p>
                    <AssignmentActions orgId={f.orgId} taskId={a.id} response={a.response} locale={L} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="pay">
            <h2 id="pay">{t(L, 'work.payments')}</h2>
            {r.data.bills.length === 0 ? <p className="pt-empty">{t(L, 'work.no_bills')}</p> : (
              <ul className="pt-list">
                {r.data.bills.map((b) => (
                  <li key={b.id}>
                    <div className="pt-row">
                      <span>{b.number ?? '—'} · {date(b.date, L)}</span>
                      <Status kind={b.status === 'PAID' ? 'ready' : b.on_hold ? 'blocked' : 'track'} pip={b.status === 'PAID' ? 'closed' : 'open'}>
                        {b.on_hold ? t(L, 'work.on_hold') : b.status === 'PAID' && b.paid_at ? t(L, 'work.paid_on', { date: date(b.paid_at, L) })
                          : b.scheduled_on ? t(L, 'work.scheduled', { date: date(b.scheduled_on, L) }) : b.status}
                      </Status>
                      <span className="n">{money(b.total_cents, L)}</span>
                    </div>
                    {b.retainage_cents > 0 && <div className="pt-row pt-cap"><span>{t(L, 'work.retainage')}</span><span className="n">{money(b.retainage_cents, L)}</span></div>}
                    {b.payments.map((p, k) => <div key={k} className="pt-row pt-cap"><span>{date(p.date, L)} · {p.method ?? ''}</span><span className="n">{money(p.amount_cents, L)}</span></div>)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="compliance" id="compliance">
            <h2 id="cmp">{t(L, 'work.compliance')}</h2>
            {r.data.requirements.length > 0 && (
              <div className="pt-sheet">
                <p className="pt-cap">{t(L, 'work.requirements')}</p>
                {r.data.requirements.map((q, i) => (
                  <p key={i} style={{ margin: '4px 0' }}>
                    {[q.w9 ? 'W-9' : null, q.coi ? `COI${q.min_gl_each_occurrence_cents ? ` · GL ${money(q.min_gl_each_occurrence_cents, L)}` : ''}` : null,
                      q.wc ? 'WC' : null, q.additional_insured ? 'Additional insured' : null].filter(Boolean).join(' · ')}
                    {q.certificate_holder ? <span className="pt-cap"> · {q.certificate_holder}</span> : null}
                  </p>
                ))}
              </div>
            )}
            <ul className="pt-list">
              {r.data.submissions.map((s) => (
                <li key={s.id} className="pt-row">
                  <span>{s.kind}</span>
                  <span className="pt-cap">{s.status === 'accepted' ? t(L, 'work.accepted') : s.status === 'rejected' ? t(L, 'work.rejected', { reason: s.decision_reason ?? '' }) : t(L, 'work.received', { date: date(s.received_at, L) })}</span>
                </li>
              ))}
              {r.data.coverages.map((c, i) => <li key={`c${i}`} className="pt-row"><span>{c.type}{c.carrier ? ` · ${c.carrier}` : ''}</span><span className="pt-cap">{date(c.expires, L)}</span></li>)}
            </ul>
            <div className="pt-actions">
              <ComplianceUpload orgId={f.orgId} kind="W9" locale={L} label={t(L, 'work.upload_w9')} />
              <ComplianceUpload orgId={f.orgId} kind="COI" locale={L} label={t(L, 'work.upload_coi')} />
            </div>
            {r.data.job_compliance.length > 0 && (
              <ul className="pt-list" style={{ marginTop: 12 }}>
                {r.data.job_compliance.map((c) => (
                  <li key={c.id}>
                    <div className="pt-row"><span>{c.type.replace(/_/g, ' ')} · {c.job.name}</span><span className="pt-cap">{c.status}{c.amount_cents ? ` · ${money(c.amount_cents, L)}` : ''}</span></div>
                    {['MISSING', 'REJECTED', 'EXPIRED'].includes(c.status) && (
                      <ComplianceUpload orgId={f.orgId} kind={c.type.startsWith('LIEN_WAIVER') ? 'LIEN_WAIVER' : 'OTHER'} complianceDocId={c.id} locale={L} label={t(L, 'action.upload')} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </PortalFrame>
  );
}
