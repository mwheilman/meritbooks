'use client';

import { useMemo, useState } from 'react';
import { Button, Field, InlineNotice, Input } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { money } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { CommitmentLine, Locale } from '@/lib/portal/types';
import { UploadField } from './UploadField';

/** Integer-cents math the database repeats (portal.submit_pay_app): this period = round(amount × pct) − billed. Pure. */
export function payAppMath(lines: readonly CommitmentLine[], pct: Readonly<Record<string, number>>, retainagePct: number) {
  let gross = 0; let ret = 0;
  const rows = lines.map((l) => {
    const p = Math.min(1, Math.max(0, pct[l.id] ?? l.billed_cents / Math.max(1, l.amount_cents)));
    const toDate = Math.round(l.amount_cents * p);
    const thisPeriod = Math.max(0, toDate - l.billed_cents);
    const r = Math.round(thisPeriod * retainagePct);
    gross += thisPeriod; ret += r;
    return { id: l.id, pct: p, thisPeriod, retainage: r };
  });
  return { rows, gross, retainage: ret, net: gross - ret };
}

/** A sub bills against the contract's own lines (% complete to date per line); retainage at the contract rate. */
export function PayAppForm({ orgId, commitmentId, lines, retainagePct, locale }: {
  orgId: string; commitmentId: string; lines: readonly CommitmentLine[]; retainagePct: number; locale: Locale;
}) {
  const [pct, setPct] = useState<Record<string, number>>({});
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceNo, setInvoiceNo] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ application_no: number; net_cents: number } | null>(null);
  const m = useMemo(() => payAppMath(lines, pct, retainagePct), [lines, pct, retainagePct]);
  if (sent) return <InlineNotice title={`${t(locale, 'pay.history')} #${sent.application_no} · ${money(sent.net_cents, locale)}`}>{t(locale, 'item.sent')}</InlineNotice>;
  return (
    <form className="pt-form" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const r = await portalPost<{ application_no: number; net_cents: number }>('/api/portal/actions', {
        op: 'pay_app', orgId, commitmentId, periodEnd, invoiceNo: invoiceNo.trim() || null, documentId: doc,
        lines: m.rows.filter((x) => x.thisPeriod > 0).map((x) => ({ line_id: x.id, pct_complete: Math.round(x.pct * 10000) / 10000 })),
      });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setSent(r.data);
    }}>
      <div className="pt-scroll">
        <table className="pt-tbl">
          <thead><tr><th>{t(locale, 'draw.line')}</th><th className="n">{t(locale, 'pay.contract')}</th><th className="n">{t(locale, 'pay.billed')}</th><th className="n">{t(locale, 'pay.pct')}</th><th className="n">{t(locale, 'pay.this_period')}</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="n">{money(l.amount_cents, locale)}</td>
                <td className="n">{money(l.billed_cents, locale)}</td>
                <td className="n">
                  <input type="number" min={0} max={100} step={1} inputMode="decimal" aria-label={`${t(locale, 'pay.pct')} ${l.description}`} style={{ width: 72, textAlign: 'right' }}
                         value={Math.round(m.rows[i].pct * 100)} onChange={(e) => setPct((x) => ({ ...x, [l.id]: Number(e.target.value) / 100 }))} />
                </td>
                <td className="n">{money(m.rows[i].thisPeriod, locale)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4}>{t(locale, 'pay.this_period')}</td><td className="n">{money(m.gross, locale)}</td></tr>
            <tr><td colSpan={4}>{t(locale, 'pay.retainage', { pct: Math.round(retainagePct * 1000) / 10 })}</td><td className="n">({money(m.retainage, locale)})</td></tr>
            <tr><td colSpan={4}>{t(locale, 'pay.net')}</td><td className="n">{money(m.net, locale)}</td></tr>
          </tfoot>
        </table>
      </div>
      <Field label={t(locale, 'pay.period_end')}><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required /></Field>
      <Field label={t(locale, 'pay.invoice_no')}><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} /></Field>
      <UploadField orgId={orgId} purpose="pay_app" locale={locale} label={t(locale, 'pay.attach')} accept="application/pdf" onUploaded={(f) => setDoc(f.documentId)} />
      {error && <InlineNotice tone="neg" title={error} />}
      <div><Button type="submit" variant="primary" size="lg" disabled={busy || m.gross <= 0}>{t(locale, 'pay.submit')}</Button></div>
    </form>
  );
}
