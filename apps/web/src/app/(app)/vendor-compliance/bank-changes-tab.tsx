'use client';

import { useState } from 'react';
import { Button, ConfirmDialog, Dialog, Field, InlineNotice, Input, Pip, QueueTable, Select, Tag, Textarea, api, toast, useQuery, type QueueColumn } from '@meritbooks/merit-ui';
import { PHONE_SOURCE_OPTIONS, actorWord, relative, type ActionResponse, type BankChangeListRow } from './vc-types';
import s from './vendor-compliance.module.css';

const SOURCE_WORD: Record<string, string> = { vendor_portal: 'Vendor portal upload', payment_profile: 'Payment profile edited', manual: 'Reported by phone / email' };
const STATUS_LOOK: Record<string, { pip: 'blocked' | 'ready' | 'closed'; word: string }> = {
  pending: { pip: 'blocked', word: 'Call-back needed' },
  verified: { pip: 'ready', word: 'Verified' },
  rejected: { pip: 'closed', word: 'Rejected' },
  cancelled: { pip: 'closed', word: 'Cancelled' },
};

/**
 * VN-10: every vendor bank-detail change waits for an out-of-band call-back before money
 * moves. The number to call is the one ALREADY on file — never the one on the request.
 */
export function BankChangesTab({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { data, error, isLoading, refetch } = useQuery<{ rows: BankChangeListRow[] }>('/api/vendor-compliance/bank-changes', undefined, { key: String(refreshKey), scope: false });
  const [verify, setVerify] = useState<BankChangeListRow | null>(null);
  const [reject, setReject] = useState<BankChangeListRow | null>(null);
  const rows = data?.rows ?? [];
  const done = () => {
    void refetch();
    onChanged();
  };

  const columns: QueueColumn<BankChangeListRow>[] = [
    {
      id: 'status',
      header: 'Status',
      width: 156,
      cell: (r) => {
        const l = STATUS_LOOK[r.status] ?? STATUS_LOOK.pending;
        return <span className="mb-sev"><Pip kind={l.pip} />{l.word}</span>;
      },
    },
    {
      id: 'vendor',
      header: 'Vendor',
      cell: (r) => (
        <>
          <span className="l1">{r.vendor_name}</span>
          <span className="l2">
            {[SOURCE_WORD[r.source] ?? r.source, r.new_bank_name, r.new_account_mask ? `new account ${r.new_account_mask}` : null, r.prior_account_mask ? `was ${r.prior_account_mask}` : null].filter(Boolean).join(' · ')}
          </span>
        </>
      ),
    },
    { id: 'opened', header: 'Changed', width: 112, cell: (r) => <span className="ink-2" title={r.opened_at}>{relative(r.opened_at)}</span> },
    {
      id: 'decided',
      header: 'Call-back',
      width: 220,
      cell: (r) =>
        r.status === 'pending' ? (
          <span className="ink-2">Call {r.vendor_phone ?? 'a number on file'}</span>
        ) : r.status === 'verified' ? (
          <span className="ink-2">{r.contact_name} · {relative(r.called_at)}</span>
        ) : (
          <span className="ink-3">{r.decision_reason}</span>
        ),
    },
  ];

  return (
    <div>
      <div className={s.toolbar}>
        <p className="t-cap">Payments to a vendor whose banking changed are held until someone calls them at a number you already had and records the call here. The person who made the change cannot verify it.</p>
      </div>
      {error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load bank changes.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : isLoading && !data ? (
        <div className={s.state} role="status"><p className="t-cap">Loading bank changes…</p></div>
      ) : rows.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No bank changes.</p>
          <p className="ink-2">When a vendor sends new banking through the portal, or someone edits a vendor’s payment profile, it shows here and payments to that vendor wait for a call-back.</p>
        </div>
      ) : (
        <QueueTable
          aria-label="Vendor bank changes"
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          rowState={(r) => ({ attn: r.status === 'pending', done: r.status !== 'pending' })}
          onOpen={(r) => r.status === 'pending' && setVerify(r)}
          openOnClick
          actions={[
            { key: 'v', label: 'Record call-back', run: (rs) => rs[0]?.status === 'pending' && setVerify(rs[0]) },
            { key: 'x', label: 'Reject change', run: (rs) => rs[0]?.status === 'pending' && setReject(rs[0]) },
          ]}
        />
      )}

      {verify && <VerifyDialog row={verify} onClose={() => setVerify(null)} onDone={() => { setVerify(null); done(); }} />}
      <ConfirmDialog
        open={!!reject}
        onClose={() => setReject(null)}
        title={`Reject the bank change for ${reject?.vendor_name ?? ''}?`}
        confirmLabel="Reject change"
        tone="danger"
        reason={{ label: 'Why? (goes on the audit trail)', minLength: 3, placeholder: 'Vendor says they did not change banks — likely phishing' }}
        onConfirm={async (reason) => {
          if (!reject) return;
          const res = await api.post<ActionResponse>('/api/vendor-compliance/bank-changes', { action: 'reject', id: reject.id, reason: reason ?? '' });
          setReject(null);
          if (res.error) {
            toast.error(res.error.error);
            return;
          }
          toast(res.data?.message ?? 'Rejected.');
          done();
        }}
      >
        {reject?.source === 'payment_profile' ? 'Payments stay held until the payment profile is put back on the verified details.' : 'The uploaded banking document is ignored; payments continue on the details already on file.'}
      </ConfirmDialog>
    </div>
  );
}

function VerifyDialog({ row, onClose, onDone }: { row: BankChangeListRow; onClose: () => void; onDone: () => void }) {
  const [phone, setPhone] = useState(row.vendor_phone ?? '');
  const [source, setSource] = useState<string>(row.vendor_phone ? 'vendor_master' : '');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const digits = (p: string | null) => (p ?? '').replace(/\D/g, '').slice(-10);
  const sameAsRequest = !!row.request_phone && digits(row.request_phone).length > 0 && digits(phone) === digits(row.request_phone);

  const submit = async () => {
    setErr(null);
    if (sameAsRequest) return setErr('That is the number that came with the change request. Call a number you already had on file.');
    if (!source) return setErr('Say where the number you called came from.');
    if (contact.trim().length < 2) return setErr('Record who confirmed the change.');
    setBusy(true);
    const res = await api.post<ActionResponse>('/api/vendor-compliance/bank-changes', { action: 'verify', id: row.id, phone_used: phone, phone_source: source, contact_name: contact.trim(), notes: notes.trim() || undefined });
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(res.data?.message ?? 'Verified.');
    onDone();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissOnScrim={false}
      title={`Record the call-back to ${row.vendor_name}`}
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || sameAsRequest}>{busy ? 'Saving…' : 'Verified — release payments'}</Button>
        </>
      }
      footNote={`Opened by ${actorWord(row.opened_by)} · ${SOURCE_WORD[row.source] ?? row.source}`}
    >
      <div className={s.formGrid}>
        <InlineNotice tone="warn" title="Never call the number on the request.">
          Fraudsters send “our bank changed” with a number they answer. Call the vendor at a number you already had{row.request_phone ? ` — not ${row.request_phone}` : ''}.
        </InlineNotice>
        <Field label="Number you called" error={sameAsRequest ? 'This is the number from the change request.' : undefined}>
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="515-555-0100" />
        </Field>
        <Field label="Where the number came from">
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Choose…</option>
            {PHONE_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Who confirmed the change"><Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Pat Lee, office manager" /></Field>
        <Field label="Notes (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></Field>
        <p className="t-cap">
          <Tag>{row.new_bank_name ?? 'New bank'}</Tag> {row.new_account_mask ? `account ${row.new_account_mask}` : 'see the uploaded document'}
        </p>
        {err && <InlineNotice tone="neg" title="Can’t verify yet.">{err}</InlineNotice>}
      </div>
    </Dialog>
  );
}
