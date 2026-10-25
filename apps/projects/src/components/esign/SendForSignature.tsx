'use client';

import { useState } from 'react';
import { Button, Dialog, Field, InlineNotice, Input, Seg, Select, Textarea, api, toast } from '@meritbooks/merit-ui';
import type { CompletionKind } from '@/lib/esign/types';

interface SignerDraft { name: string; email: string; phone: string; roleLabel: string; channel: 'email' | 'sms' | 'both' | 'link' }

interface Delivery { signerId: string; name: string; channel: string; email: string; sms: string; manual: boolean; link: string | null; detail: string | null }

const SUBJECT_KIND: Record<string, CompletionKind> = { estimates: 'estimate', change_orders: 'change_order', compliance_docs: 'lien_waiver', dealer_quotes: 'dealer_quote' };
const SUBJECT_WORD: Record<CompletionKind, string> = {
  estimate: 'accept the estimate (creates the contract and budget)',
  change_order: 'approve the change order (or queue it for an internal approver)',
  lien_waiver: 'mark the lien waiver received',
  dealer_quote: 'accept the quote and write the deal',
};

const blank = (): SignerDraft => ({ name: '', email: '', phone: '', roleLabel: '', channel: 'email' });

/** Send a document for signature: signers in order, how each gets the link, and what happens when everyone signs. */
export function SendForSignature({ open, onClose, fileId, title, subjectTable, subjectId, onSent }: {
  open: boolean; onClose: () => void; fileId: string; title: string; subjectTable: string | null; subjectId: string | null; onSent: () => void;
}) {
  const [signers, setSigners] = useState<SignerDraft[]>([blank()]);
  const [routing, setRouting] = useState<'sequential' | 'parallel'>('sequential');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Delivery[] | null>(null);
  const kind = subjectTable ? SUBJECT_KIND[subjectTable] : undefined;

  const set = (i: number, patch: Partial<SignerDraft>) => setSigners((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const send = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ envelopeId: string; deliveries: Delivery[] }>('/api/sign', {
      documentId: fileId, title, message: message.trim() || undefined, routing, expiresDays: Number(days),
      signers: signers.map((s, i) => ({ name: s.name.trim(), email: s.email.trim() || null, phone: s.phone.trim() || null, roleLabel: s.roleLabel.trim() || null, channel: s.channel, order: routing === 'sequential' ? i + 1 : 1 })),
      onCompleted: kind && subjectId ? { kind, id: subjectId } : null,
    });
    setBusy(false);
    if (res.error) { setError(res.error.error); return; }
    const d = res.data?.deliveries ?? [];
    toast(d.some((x) => x.manual) ? 'Sent for signature — share the links below' : 'Sent for signature');
    setResult(d);
    onSent();
  };

  const close = () => { setResult(null); setSigners([blank()]); setMessage(''); setError(null); onClose(); };
  const valid = signers.every((s) => s.name.trim() && (s.channel === 'link' || ((s.channel === 'email' || s.channel === 'both') ? s.email.includes('@') : true) && ((s.channel === 'sms' || s.channel === 'both') ? s.phone.trim().length >= 7 : true)));

  return (
    <Dialog open={open} onClose={close} title={result ? 'Links sent' : 'Send for signature'} width={760} dismissOnScrim={false}
      actions={result ? <Button variant="primary" onClick={close}>Done</Button> : (
        <>
          <Button variant="quiet" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => void send()}>{busy ? 'Sending…' : `Send to ${signers.length} signer${signers.length === 1 ? '' : 's'}`}</Button>
        </>
      )}
      footNote={result ? undefined : 'Each signer gets a one-time link. The exact version you send is locked by its fingerprint; a change after sending stops the request.'}>
      {result ? (
        <div className="stack">
          {result.map((d) => (
            <div key={d.signerId} className="stack" style={{ gap: 4 }}>
              <p><b>{d.name}</b> — {d.email === 'sent' ? 'emailed' : ''}{d.email === 'sent' && d.sms === 'sent' ? ' and ' : ''}{d.sms === 'sent' ? 'texted' : ''}{d.manual ? 'not delivered: share this link with them' : ''}</p>
              {d.link && (
                <div className="esg-link">
                  <Input readOnly value={d.link} aria-label={`Signing link for ${d.name}`} onFocus={(e) => e.currentTarget.select()} />
                  <Button onClick={() => { void navigator.clipboard?.writeText(d.link ?? ''); toast('Copied the link'); }}>Copy</Button>
                </div>
              )}
              {d.detail && <p className="t-cap">{d.detail}</p>}
            </div>
          ))}
          {routing === 'sequential' && signers.length > 1 && <p className="t-cap">Later signers get their link when the one before them signs.</p>}
        </div>
      ) : (
        <div className="stack">
          <Seg<'sequential' | 'parallel'> aria-label="Signing order" value={routing} onChange={setRouting}
            items={[{ value: 'sequential', label: 'In order' }, { value: 'parallel', label: 'All at once' }]} />
          <div>
            {signers.map((s, i) => (
              <div className="esg-form-signer" key={i}>
                <span className="o">{routing === 'sequential' ? i + 1 : '·'}</span>
                <Field label="Name"><Input value={s.name} onChange={(e) => set(i, { name: e.target.value })} maxLength={120} /></Field>
                <Field label="Email"><Input type="email" value={s.email} onChange={(e) => set(i, { email: e.target.value })} maxLength={254} /></Field>
                <Field label="Mobile"><Input type="tel" value={s.phone} onChange={(e) => set(i, { phone: e.target.value })} maxLength={20} /></Field>
                <Field label="Send by">
                  <Select value={s.channel} onChange={(e) => set(i, { channel: e.target.value as SignerDraft['channel'] })}>
                    <option value="email">Email</option><option value="sms">Text</option><option value="both">Email and text</option><option value="link">I’ll share the link</option>
                  </Select>
                </Field>
                <Button variant="quiet" iconOnly icon="x" aria-label={`Remove signer ${i + 1}`} disabled={signers.length === 1} onClick={() => setSigners((x) => x.filter((_, j) => j !== i))} />
              </div>
            ))}
            {signers.length < 10 && <Button variant="quiet" icon="plus" onClick={() => setSigners((x) => [...x, blank()])}>Add signer</Button>}
          </div>
          <div className="mp-form-2">
            <Field label="Message (optional)"><Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={3} /></Field>
            <Field label="Expires after">
              <Select value={days} onChange={(e) => setDays(e.target.value)}>
                {['3', '7', '14', '30', '60', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}
              </Select>
            </Field>
          </div>
          {kind && <InlineNotice title="When everyone signs">Merit Projects will stamp the signatures, add the audit certificate as a new version and {SUBJECT_WORD[kind]}.</InlineNotice>}
          {error && <InlineNotice tone="neg" title="Not sent.">{error}</InlineNotice>}
        </div>
      )}
    </Dialog>
  );
}
