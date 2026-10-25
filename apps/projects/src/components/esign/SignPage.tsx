'use client';

import { useRef, useState } from 'react';
import { Button, Check, Field, InlineNotice, Input, Status, Textarea } from '@meritbooks/merit-ui';
import { REASON_WORD, SIGNER_STATUS_WORD, type PublicSignState } from '@/lib/esign/types';
import { SignaturePad, type SignaturePadHandle } from './SignaturePad';

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The signer's whole experience on one page: read, agree, type, draw, sign — or decline with a reason. */
export function SignPage({ token, initial, viewUrl }: { token: string; initial: PublicSignState; viewUrl: string | null }) {
  const [state, setState] = useState<PublicSignState>(initial);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState(initial.signer?.name ?? '');
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const pad = useRef<SignaturePadHandle | null>(null);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sign/public/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({ ok: false, reason: 'unavailable' }))) as PublicSignState;
      if (data.ok || data.envelope) setState((s) => ({ ...s, ...data }));
      if (!data.ok) setError(REASON_WORD[data.reason ?? ''] ?? 'That did not go through. Try again.');
    } catch {
      setError('No connection. Check your internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  const sign = () => {
    const png = pad.current?.toDataUrl();
    if (!consent) return setError(REASON_WORD.consent_required);
    if (name.trim().length < 2) return setError(REASON_WORD.name_required);
    if (!png) return setError(REASON_WORD.signature_required);
    void post({ op: 'sign', typedName: name.trim(), signaturePng: png, consent: true });
  };

  const co = state.company;
  const doc = state.envelope;
  const me = state.signer;
  const done = me?.status === 'signed';
  const declined = me?.status === 'declined' || doc?.status === 'declined';
  const canAct = !!state.can_act && !done && !declined;

  return (
    <div className="sign-page" style={co?.primary_color ? ({ ['--brand' as string]: co.primary_color } as React.CSSProperties) : undefined}>
      <header className="sign-bar">
        {co?.logo_url ? <img src={co.logo_url} alt={co.company_name} /> : null}
        <span className="co">{co?.company_name ?? 'Signature request'}</span>
        <span className="sp" style={{ flex: 1 }} />
        <span className="t-cap">Secure signing · Merit Projects</span>
      </header>
      {!doc ? (
        <main className="sign-main" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
          <InlineNotice tone="warn" title="This link can’t be used.">{REASON_WORD[state.reason ?? 'invalid'] ?? REASON_WORD.invalid}</InlineNotice>
        </main>
      ) : (
        <main className="sign-main">
          <section className="sign-doc" aria-label="Document to sign">
            {viewUrl && canAct ? (
              <iframe title={doc.title} src={`${viewUrl}#toolbar=1&view=FitH`} />
            ) : (
              <div style={{ padding: 24 }}>
                <InlineNotice title={done || declined ? 'Done.' : 'The document is not shown right now.'}>
                  {done || declined ? 'The sender keeps the signed copy with its audit certificate and will share it with you.' : 'This link can no longer show the document.'}
                </InlineNotice>
              </div>
            )}
          </section>
          <aside className="sign-side">
            <p className="t-cap">{state.document?.file_name}{state.document?.page_count ? ` · ${state.document.page_count} pages` : ''}</p>
            <h1 className="t-section">{doc.title}</h1>
            {doc.message && <p style={{ marginTop: 8 }}>{doc.message}</p>}
            {state.signers && state.signers.length > 1 && (
              <ol className="esg-signers" style={{ marginTop: 12 }} aria-label="Signers">
                {state.signers.map((s, i) => (
                  <li key={i}>
                    <span className="o">{s.routing_order}</span>
                    <span>{s.name}{s.you ? ' (you)' : ''}{s.role_label ? <span className="t-cap"> · {s.role_label}</span> : null}</span>
                    <Status kind={s.status === 'signed' ? 'ready' : s.status === 'declined' ? 'blocked' : 'track'} pip={s.status === 'signed' ? 'closed' : 'open'}>{SIGNER_STATUS_WORD[s.status]}</Status>
                  </li>
                ))}
              </ol>
            )}

            {done || declined ? (
              <div className="sign-done" style={{ marginTop: 16 }} role="status">
                <p className="b">{declined ? 'You declined this request.' : 'Signed. Thank you.'}</p>
                <p className="t-cap">{declined ? 'The sender has been told and will be in touch.' : `Signed ${when(me?.signed_at)}. ${doc.status === 'completed' ? 'Everyone has signed.' : 'The others will sign next.'}`}</p>
                {!declined && <p className="t-cap" style={{ marginTop: 8 }}>Once everyone has signed, the sender files the signed copy with its audit certificate and sends it to you. This link no longer opens the document.</p>}
              </div>
            ) : !canAct ? (
              <div style={{ marginTop: 16 }}><InlineNotice tone="warn" title="You can’t sign right now.">{REASON_WORD[state.reason ?? ''] ?? REASON_WORD.invalid}</InlineNotice></div>
            ) : declining ? (
              <form className="mp-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); void post({ op: 'decline', reason: reason.trim() }); }}>
                <Field label="Why are you declining?" help="The sender sees this, so they can fix the document.">
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required />
                </Field>
                {error && <InlineNotice tone="neg" title="Not sent.">{error}</InlineNotice>}
                <div className="btn-row">
                  <Button variant="quiet" onClick={() => setDeclining(false)}>Back</Button>
                  <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 2}>Decline to sign</Button>
                </div>
              </form>
            ) : (
              <form className="mp-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); sign(); }}>
                <div className="sign-consent">{state.consent?.text}</div>
                <Check label="I agree to sign electronically" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <Field label="Type your full name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" /></Field>
                <SignaturePad ref={pad} label="Your signature" onChange={setHasInk} disabled={busy} />
                {error && <InlineNotice tone="neg" title="Not signed yet.">{error}</InlineNotice>}
                <Button type="submit" variant="primary" size="lg" disabled={busy || !consent || !hasInk || name.trim().length < 2}>{busy ? 'Signing…' : 'Sign'}</Button>
                <p className="t-cap">Signing records your name, signature, the time, your IP address and browser. The link works once{doc.expires_at ? ` and expires ${when(doc.expires_at)}` : ''}.</p>
                <Button variant="quiet" onClick={() => { setDeclining(true); setError(null); }}>Decline to sign</Button>
              </form>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}
