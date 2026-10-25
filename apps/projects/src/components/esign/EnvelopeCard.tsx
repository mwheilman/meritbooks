'use client';

import { useState } from 'react';
import { Button, ConfirmDialog, InlineNotice, Status, api, toast } from '@meritbooks/merit-ui';
import { ENVELOPE_STATUS_WORD, SIGNER_STATUS_WORD, type EnvelopeRow, type EventRow, type SignerRow } from '@/lib/esign/types';
import { runSignCallbacks, when } from '@/components/documents/client';

const EVENT_WORD: Record<string, string> = {
  created: 'Request created', sent: 'Sent', delivered: 'Link sent', resent: 'Link re-sent', viewed: 'Opened', consented: 'Agreed to sign electronically',
  signed: 'Signed', declined: 'Declined', completed: 'Everyone signed', voided: 'Voided', expired: 'Expired', finalized: 'Signed copy filed',
  finalize_failed: 'Signed copy failed', callback_done: 'Record updated', callback_failed: 'Record update failed', token_rejected: 'Old or used link refused',
};

const statusKind = (s: EnvelopeRow['status']) => (s === 'completed' ? 'ready' : s === 'sent' || s === 'draft' ? 'track' : s === 'expired' ? 'overdue' : 'blocked');

/** One signature request: who signed, who is next, resend / void, and the audit trail. */
const SUBJECT_WORD: Record<string, string> = { estimates: 'accept the estimate', change_orders: 'approve the change order', compliance_docs: 'mark the lien waiver received', dealer_quotes: 'accept the quote' };

export function EnvelopeCard({ env, signers, events, pendingEvents, isSender, canEdit, subjectTable, onChanged }: {
  env: EnvelopeRow; signers: SignerRow[]; events: EventRow[]; pendingEvents: number; isSender: boolean; canEdit: boolean; subjectTable: string | null; onChanged: () => void;
}) {
  const [voidOpen, setVoidOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trail, setTrail] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const open = env.status === 'sent';
  const names = new Map(signers.map((s) => [s.id, s.name]));

  const resend = async (s: SignerRow) => {
    setBusy(s.id);
    const r = await api.post<{ delivery: { manual: boolean; link: string | null } }>(`/api/sign/${env.id}`, { op: 'resend', signerId: s.id });
    setBusy(null);
    if (r.error) { toast.error(r.error.error); return; }
    if (r.data?.delivery.link) setLink({ name: s.name, url: r.data.delivery.link });
    toast(r.data?.delivery.manual ? 'New link ready — share it' : `New link sent to ${s.name}`);
    onChanged();
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="btn-row">
        <Status kind={statusKind(env.status)} pip={env.status === 'completed' ? 'closed' : 'open'}>{ENVELOPE_STATUS_WORD[env.status]}</Status>
        <span className="t-cap">{env.sent_at ? `sent ${when(env.sent_at)}` : ''}{open ? ` · expires ${when(env.expires_at)}` : ''}</span>
      </div>
      {env.status === 'declined' && env.decline_reason && <InlineNotice tone="warn" title="Declined">{env.decline_reason}</InlineNotice>}
      {env.status === 'voided' && env.void_reason && <p className="t-cap">Voided: {env.void_reason}</p>}
      {(env.status === 'completed' || env.status === 'declined') && (env.finalize_state === 'pending' || env.finalize_state === 'failed' || pendingEvents > 0) && (
        <InlineNotice title={env.status === 'declined' ? 'Declined — finish the request' : 'Everyone signed — finish the request'}>
          {isSender
            ? `Finishing files the signed copy with its audit certificate${env.on_completed_kind !== 'none' && subjectTable && SUBJECT_WORD[subjectTable] ? ` and will ${SUBJECT_WORD[subjectTable]} under your name` : ''}.`
            : env.on_completed_kind !== 'none' ? 'The person who sent it finishes it: the record is updated under their authority, not yours.' : 'File the signed copy with its audit certificate.'}
          {(isSender || (canEdit && env.finalize_state !== 'done')) && (
            <div style={{ marginTop: 8 }}>
              <Button variant="primary" disabled={busy === 'finish'} onClick={async () => {
                setBusy('finish');
                const n = await runSignCallbacks(env.id);
                setBusy(null);
                toast(n > 0 ? 'Finished the signature request' : 'Updated the signature request');
                onChanged();
              }}>{isSender ? 'Finish' : 'File the signed copy'}</Button>
            </div>
          )}
        </InlineNotice>
      )}
      {env.finalize_state === 'failed' && <InlineNotice tone="neg" title="The signed copy was not built.">{env.finalize_error}</InlineNotice>}
      <ol className="esg-signers">
        {signers.map((s) => (
          <li key={s.id}>
            <span className="o">{s.routing_order}</span>
            <span>
              {s.name}{s.role_label ? <span className="t-cap"> · {s.role_label}</span> : null}
              <span className="t-cap" style={{ display: 'block' }}>{[s.email, s.phone].filter(Boolean).join(' · ')}{s.signed_at ? ` · signed ${when(s.signed_at)}${s.sign_ip ? ` from ${s.sign_ip}` : ''}` : ''}</span>
              {s.decline_reason && <span className="t-cap" style={{ display: 'block' }}>“{s.decline_reason}”</span>}
            </span>
            <span className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
              <Status kind={s.status === 'signed' ? 'ready' : s.status === 'declined' ? 'blocked' : 'track'} pip={s.status === 'signed' ? 'closed' : 'open'}>{SIGNER_STATUS_WORD[s.status]}</Status>
              {open && ['sent', 'viewed', 'pending_send'].includes(s.status) && (
                <Button variant="quiet" disabled={busy === s.id} onClick={() => void resend(s)}>{s.status === 'pending_send' ? 'Send link' : 'New link'}</Button>
              )}
            </span>
          </li>
        ))}
      </ol>
      {link && (
        <div className="esg-link">
          <input className="input" readOnly value={link.url} aria-label={`Signing link for ${link.name}`} onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={() => { void navigator.clipboard?.writeText(link.url); toast('Copied the link'); }}>Copy</Button>
        </div>
      )}
      <div className="btn-row">
        <Button variant="quiet" icon="history" onClick={() => setTrail((t) => !t)}>{trail ? 'Hide audit trail' : 'Audit trail'}</Button>
        <span className="sp" style={{ flex: 1 }} />
        {(open || env.status === 'draft') && <Button variant="quiet" onClick={() => setVoidOpen(true)}>Void request</Button>}
      </div>
      {trail && (
        <ol className="esg-trail" aria-label="Audit trail">
          {events.map((e) => (
            <li key={e.id}><time dateTime={e.at}>{when(e.at)}</time><span>{EVENT_WORD[e.event] ?? e.event}{e.signer_id ? ` — ${names.get(e.signer_id) ?? 'signer'}` : ''}{e.ip ? ` · IP ${e.ip}` : ''}</span></li>
          ))}
          <li><time /><span className="docs-hash">Sent version fingerprint (SHA-256) {env.original_sha256}{env.signed_sha256 ? ` · signed copy ${env.signed_sha256}` : ''}</span></li>
        </ol>
      )}
      <ConfirmDialog open={voidOpen} onClose={() => setVoidOpen(false)} tone="danger" title="Void this signature request" confirmLabel="Void request"
        reason={{ label: 'Why (the audit trail keeps it)', minLength: 3 }}
        onConfirm={async (reason) => {
          const r = await api.post(`/api/sign/${env.id}`, { op: 'void', reason });
          if (r.error) throw new Error(r.error.error);
          toast('Voided the request');
          onChanged();
        }}>
        Every unused link stops working. Signatures already given stay in the audit trail.
      </ConfirmDialog>
    </div>
  );
}
