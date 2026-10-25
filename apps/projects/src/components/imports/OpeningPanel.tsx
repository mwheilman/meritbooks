'use client';

import { useState } from 'react';
import { Button, ButtonLink, Field, Input, InlineNotice, MoneyInput, Pip, Tag, count, money, toast, type PipKind } from '@meritbooks/merit-ui';
import type { OpeningKind, TieLine, TieOut } from '@/lib/imports/types';
import { postJson } from './api';
import type { OpeningResponse } from './types';

export const KIND_LABEL: Record<OpeningKind, string> = {
  JOB_WIP: 'Jobs under way (WIP, retainage, deposits)', AGREEMENT_DEFERRED: 'Agreements (deferred revenue)', DEALER_UNITS: 'Units and floor plan',
  OPEN_AR: 'Open invoices (AR)', CUSTOMER_DEPOSITS: 'Customer deposits', PARTS_INVENTORY: 'Parts inventory', WARRANTY_RECEIVABLE: 'Open warranty claims',
};

const STATUS_PIP: Record<string, PipKind> = { ok: 'ready', pending: 'open', exception: 'blocked', missing_in_books: 'risk', missing_in_import: 'risk', cost_differs: 'blocked', floor_differs: 'blocked', lender_differs: 'risk' };
const STATUS_WORD: Record<string, string> = { ok: 'Ties', pending: 'Waiting on Books', exception: 'Differs', missing_in_books: 'Not in Books yet', missing_in_import: 'Only in Books', cost_differs: 'Cost differs', floor_differs: 'Floor plan differs', lender_differs: 'Lender differs' };

/** Last day of the previous month (Books' default cut-over). */
export function defaultAsOf(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return d.toISOString().slice(0, 10);
}

const isCents = (k: string) => /_cents$/.test(k);

function figure(l: TieLine, side: 'source' | 'books'): string {
  const v = side === 'source' ? (l.source_cents ?? l.source_cost_cents) : (l.books_cents ?? l.books_cost_cents);
  return typeof v === 'number' ? money(v) : '—';
}

/**
 * The opening position one kind of import hands to Merit Books (PLT-70): build it from what was
 * brought in, see it tie (or not) to Books line by line, send it. Projects never posts the GL.
 */
export function OpeningPanel({ companyId, kind, booksUrl }: { companyId: string; kind: OpeningKind; booksUrl: string }) {
  const [asOf, setAsOf] = useState(defaultAsOf());
  const [reported, setReported] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | 'build' | 'tie' | 'submit'>(null);
  const [res, setRes] = useState<OpeningResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = async () => {
    setBusy('build'); setError(null);
    const r = await postJson<OpeningResponse>('/api/imports/opening', { companyId, kind, asOf, sourceReportedDeferredCents: kind === 'AGREEMENT_DEFERRED' ? reported : null });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setRes(r.data);
  };
  const act = async (op: 'tieout' | 'submit') => {
    if (!res) return;
    setBusy(op === 'tieout' ? 'tie' : 'submit');
    const r = await postJson<{ tieout: TieOut; submitted?: { status: string } }>(`/api/imports/opening/${res.handoff.handoff_id}`, { op });
    setBusy(null);
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    setRes({ ...res, tieout: r.data.tieout, handoff: { ...res.handoff, status: r.data.submitted?.status ?? res.handoff.status } });
    if (op === 'submit') toast('Sent to Merit Books. It records the opening balances through its own import and the tie-out turns green as it does.');
  };

  const t = res?.tieout;
  const totals = res ? Object.entries(res.handoff.totals).filter(([, v]) => typeof v === 'number' || typeof v === 'string') : [];
  const fileBase = res ? `/api/imports/opening/${res.handoff.handoff_id}/file` : '';

  return (
    <section className="ob-card imp-opening" aria-label={KIND_LABEL[kind]}>
      <div className="ob-card-h">
        <h3>Opening balances: {KIND_LABEL[kind]}</h3>
        {res && <Tag tone={res.handoff.status === 'VALIDATED' || res.handoff.status === 'SUBMITTED' ? 'pos' : 'warn'}>{res.handoff.status.toLowerCase()}</Tag>}
      </div>
      <div className="ob-card-b">
        <div className="imp-opening-form">
          <Field label="As of (cut-over date)" help="The day your old system’s numbers are from."><Input type="date" value={asOf} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAsOf(e.currentTarget.value)} /></Field>
          {kind === 'AGREEMENT_DEFERRED' && (
            <Field label="Deferred balance on the old system’s report" help="Optional. We check the agreements add up to it.">
              <MoneyInput valueCents={reported} onChangeCents={setReported} />
            </Field>
          )}
          <Button variant="primary" disabled={busy !== null || !asOf} onClick={build}>{busy === 'build' ? 'Building…' : res ? 'Rebuild' : 'Build and tie out'}</Button>
        </div>
        {error && <InlineNotice tone="neg" title={error} />}
        {res && (
          <>
            <div className="imp-entity">
              {totals.map(([k, v]) => <span key={k}>{k.replace(/_cents$/, '').replace(/_/g, ' ')} <b className="tnum">{isCents(k) ? money(Number(v)) : count(Number(v))}</b></span>)}
            </div>
            {res.handoff.blockers.length > 0 && (
              <InlineNotice tone="warn" title={`${res.handoff.blockers.length} to fix before Books can take it`}>{res.handoff.blockers.slice(0, 5).map((b) => b.message).join(' · ')}</InlineNotice>
            )}
            {res.warnings.length > 0 && <ul className="ob-list">{res.warnings.slice(0, 5).map((w) => <li key={w.message}>{w.message}</li>)}</ul>}
          </>
        )}
      </div>
      {t && (
        <div className="ob-tbl">
          <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Tie-out to Merit Books">
            <thead><tr><th>Check</th><th className="num">From the import</th><th className="num">In Books</th><th>Result</th></tr></thead>
            <tbody>
              {[...t.controls, ...t.lines].slice(0, 60).map((l, i) => (
                <tr key={`${l.key}-${i}`}>
                  <td>{l.label}</td>
                  <td className="num tnum">{figure(l, 'source')}</td>
                  <td className="num tnum">{figure(l, 'books')}</td>
                  <td><span className="status"><Pip kind={STATUS_PIP[l.status] ?? 'open'} />{STATUS_WORD[l.status] ?? l.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {res && t && (
        <div className="ob-card-f">
          <span className="tnum">{count(t.summary.ok)} tie · {count(t.summary.pending)} waiting on Books · {count(t.summary.exceptions)} differ</span>
          <span className="sp" />
          {kind === 'JOB_WIP' && <ButtonLink variant="quiet" href={`${fileBase}?part=books_wip_jobs&format=json`}>Books WIP file</ButtonLink>}
          {kind === 'DEALER_UNITS' && <ButtonLink variant="quiet" href={`${fileBase}?part=books_opening_rows`}>Books opening units file</ButtonLink>}
          <ButtonLink variant="quiet" href={`${booksUrl}/onboarding/conversion`} target="_blank" rel="noreferrer">Opening balances in Books</ButtonLink>
          <Button disabled={busy !== null} onClick={() => act('tieout')}>{busy === 'tie' ? 'Checking…' : 'Check again'}</Button>
          <Button variant="primary" disabled={busy !== null || res.handoff.status !== 'VALIDATED'} onClick={() => act('submit')}>{busy === 'submit' ? 'Sending…' : res.handoff.status === 'SUBMITTED' ? 'Sent to Books' : 'Send to Merit Books'}</Button>
        </div>
      )}
    </section>
  );
}
