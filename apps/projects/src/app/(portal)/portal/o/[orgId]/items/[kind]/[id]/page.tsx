import { InlineNotice, Status } from '@meritbooks/merit-ui';
import { DecisionPanel } from '@/components/portal/DecisionPanel';
import { PayAppForm } from '@/components/portal/PayAppForm';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { date, money } from '@/lib/portal/format';
import { orgFrame } from '@/lib/portal/frame';
import { kindLabel, t } from '@/lib/portal/i18n';
import { loadPortal } from '@/lib/portal/load';
import { isUuid } from '@/lib/portal/tokens';
import type { CommitmentLine, ItemLine, PortalItem } from '@/lib/portal/types';

export const dynamic = 'force-dynamic';

const KINDS = ['estimate', 'change_order', 'selection', 'commitment'] as const;
type Kind = (typeof KINDS)[number];

/** A proposal / change order / selection / contract: what it is, what it costs, and the decision. */
export default async function PortalItemPage({ params }: { params: { orgId: string; kind: string; id: string } }) {
  const f = await orgFrame(params.orgId);
  const L = f.locale;
  const kind = (KINDS as readonly string[]).includes(params.kind) ? (params.kind as Kind) : null;
  const r = kind && isUuid(params.id) ? await loadPortal<PortalItem>('item', { p_org: f.orgId, p_kind: kind, p_id: params.id }) : null;
  const frame = (children: React.ReactNode) => (
    <PortalFrame locale={L} brand={f.brand} orgId={f.orgId} audiences={f.audiences} signedIn multiOrg={f.multiOrg}>{children}</PortalFrame>
  );
  if (!kind || !r || !r.ok) return frame(<InlineNotice tone="warn" title={t(L, 'err.not_found')} />);
  const it = r.data;
  const open = (kind === 'estimate' && it.status === 'SENT') || (kind === 'change_order' && it.status === 'COR')
            || (kind === 'selection' && it.status === 'PROPOSED') || (kind === 'commitment' && it.status === 'APPROVED');
  const amount = it.total_cents ?? it.amount_cents ?? null;
  return frame(
    <>
      <p className="pt-cap">{kindLabel(L, kind)}{it.number ? ` · ${it.number}` : ''} · <a href={`/portal/o/${f.orgId}/jobs/${it.job.id}`}>{it.job.name}</a></p>
      <h1>{kind === 'selection' ? `${it.category}: ${it.title}` : it.title}</h1>
      {it.description && <p className="pt-lead" style={{ whiteSpace: 'pre-wrap' }}>{it.description}</p>}
      <div className="pt-sheet">
        {kind === 'selection' ? (
          <div className="pt-row"><span>{t(L, 'item.allowance')}</span><span className="n">{money(it.allowance_cents ?? null, L)}</span></div>
        ) : (
          <div className="pt-row"><b>{t(L, kind === 'change_order' ? 'item.change' : 'item.total')}</b><b className="n">{money(amount, L)}</b></div>
        )}
        {kind === 'change_order' && it.schedule_days ? (
          <div className="pt-row"><span>{t(L, 'item.schedule_days')}</span><span className="n">{t(L, 'item.days', { n: it.schedule_days })}</span></div>
        ) : null}
        {it.valid_until && <p className="pt-cap">{t(L, 'item.valid_until', { date: date(it.valid_until, L) })}</p>}
        {it.due_on && <p className="pt-cap">{date(it.due_on, L)}</p>}
        {!open && <p style={{ marginTop: 8 }}><Status kind="ready" pip="closed">{it.status}</Status></p>}
      </div>

      {kind !== 'selection' && (it.lines ?? []).length > 0 && (
        <>
          <h2>{t(L, 'item.lines')}</h2>
          <div className="pt-scroll">
            <table className="pt-tbl">
              <tbody>
                {(it.lines ?? []).map((l, i) => (
                  <tr key={i}>
                    <td>{(l as ItemLine).description}{(l as ItemLine).allowance ? <span className="pt-cap"> · {t(L, 'item.allowance')}</span> : null}</td>
                    <td className="n">{l.qty !== null && l.qty !== undefined ? `${Number(l.qty)} ${l.uom ?? ''}` : ''}</td>
                    <td className="n">{money(l.amount_cents, L)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>{t(L, 'item.total')}</td><td className="n">{money(kind === 'commitment' ? (it.lines ?? []).reduce((s, l) => s + l.amount_cents, 0) : amount, L)}</td></tr></tfoot>
            </table>
          </div>
        </>
      )}

      {open && (
        <div style={{ marginTop: 16 }}>
          <DecisionPanel orgId={f.orgId} kind={kind} id={it.id} locale={L} company={f.company} canAct={it.can_act} verified={it.verified}
                         phoneHint={f.phoneHint} signerId={it.can_sign ? it.signer_id : null} decided={it.decided ?? null}
                         options={it.options} allowanceCents={it.allowance_cents ?? null} />
        </div>
      )}

      {kind === 'commitment' && ['APPROVED', 'EXECUTED'].includes(it.status) && it.can_act && !it.payment_hold && (
        <section aria-labelledby="pay">
          <h2 id="pay">{t(L, 'pay.title')}</h2>
          <div className="pt-sheet"><PayAppForm orgId={f.orgId} commitmentId={it.id} lines={(it.lines ?? []) as CommitmentLine[]} retainagePct={Number(it.retainage_pct ?? 0)} locale={L} /></div>
        </section>
      )}
      {kind === 'commitment' && (it.pay_apps ?? []).length > 0 && (
        <section aria-labelledby="hist">
          <h2 id="hist">{t(L, 'pay.history')}</h2>
          <ul className="pt-list">
            {(it.pay_apps ?? []).map((a) => (
              <li key={a.id} className="pt-row">
                <span>#{a.application_no} · {date(a.period_end, L)}</span>
                <Status kind={a.status === 'approved' ? 'ready' : a.status === 'rejected' ? 'blocked' : 'track'} pip={a.status === 'submitted' ? 'open' : 'closed'}>{a.status}</Status>
                <span className="n">{money(a.net_cents, L)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>,
  );
}
