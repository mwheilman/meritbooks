import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { booksPayUrl, date, money } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import type { InvoiceRow } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

/** Invoices and payments from Merit Books; Pay opens Books' hosted pay page where it can take payment. */
export default async function PortalInvoicesPage({ params }: { params: { orgId: string } }) {
  const f = await orgFrame(params.orgId);
  const L = f.locale;
  const r = await loadPortal<{ invoices: InvoiceRow[] }>('invoices', { p_org: f.orgId });
  return (
    <PortalFrame locale={L} brand={f.brand} orgId={f.orgId} audiences={f.audiences} active="invoices" signedIn multiOrg={f.multiOrg}>
      <h1>{t(L, 'inv.title')}</h1>
      {!r.ok ? <InlineNotice tone="warn" title={t(L, 'err.not_found')} /> : r.data.invoices.length === 0 ? <p className="pt-empty">{t(L, 'inv.empty')}</p> : (
        r.data.invoices.map((i) => {
          const open = i.balance_cents > 0 && ['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status);
          return (
            <div key={i.id} className="pt-card">
              <div className="top">
                <span className="pt-cap">{t(L, 'inv.number')} {i.number}{i.job ? ` · ${i.job.name}` : ''}</span>
                <Status kind={i.status === 'PAID' ? 'ready' : i.status === 'OVERDUE' ? 'overdue' : 'track'} pip={i.status === 'PAID' ? 'closed' : 'open'}>{i.status}</Status>
              </div>
              <div className="pt-row" style={{ marginTop: 8 }}><span>{t(L, 'inv.total')}</span><span className="n">{money(i.total_cents, L)}</span></div>
              <div className="pt-row"><span>{t(L, 'inv.paid')}</span><span className="n">{money(i.paid_cents, L)}</span></div>
              <div className="pt-row"><b>{t(L, 'inv.balance')}</b><b className="n">{money(i.balance_cents, L)}</b></div>
              {open && <p className="pt-cap">{t(L, 'inv.due')} {date(i.due_date, L)}</p>}
              <div className="pt-actions">
                {i.pay_token ? <a className="btn btn--primary" href={booksPayUrl(i.pay_token)} target="_blank" rel="noopener noreferrer">{t(L, 'inv.pay')}</a>
                  : i.view_token ? <a className="btn" href={booksPayUrl(i.view_token)} target="_blank" rel="noopener noreferrer">{t(L, 'inv.view')}</a>
                  : open ? <span className="pt-cap">{t(L, 'inv.read_only')}</span> : null}
              </div>
              {i.payments.length > 0 && (
                <ul className="pt-list" style={{ marginTop: 8 }}>
                  {i.payments.map((p, k) => <li key={k} className="pt-row"><span>{date(p.date, L)} · {p.method ?? ''}</span><span className="n">{money(p.amount_cents, L)}</span></li>)}
                </ul>
              )}
            </div>
          );
        })
      )}
    </PortalFrame>
  );
}
