'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Input, InlineNotice, Select, Textarea, api, toast, useDebounce, useQuery } from '@meritbooks/merit-ui';
import type { RequestKind } from '@/lib/requests/types';
import type { RecipientsResponse } from './requests-types';
import s from './requests.module.css';

type NewKind = Extract<RequestKind, 'w9' | 'coi' | 'client_question' | 'document' | 'approval_nudge'>;

const KINDS: ReadonlyArray<{ value: NewKind; label: string; help: string }> = [
  { value: 'w9', label: 'W-9 from a vendor', help: 'Emails the vendor their upload link. Closes itself when the W-9 arrives. Day 0, 3, 7, then weekly.' },
  { value: 'coi', label: 'Certificate of insurance from a vendor', help: 'Same upload link. For a renewal, give the expiry date: asks at T-30, T-15, T-0, then weekly.' },
  { value: 'client_question', label: 'Question for a client', help: 'A plain question by email. Day 0, 2, 5, then weekly.' },
  { value: 'document', label: 'Document from anyone', help: 'Ask for a statement, a contract, a payroll register… Day 0, 3, 7, then weekly.' },
  { value: 'approval_nudge', label: 'Nudge a teammate to approve', help: 'In-app (and email) reminder to a teammate. Daily, escalates after 2.' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Created {
  request: { id: string };
  created: boolean;
}

export interface NewRequestDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** The active client (requests for clients carry it); null = org level. */
  locationId: string | null;
  clientName: string | null;
}

export function NewRequestDialog({ open, onClose, onCreated, locationId, clientName }: NewRequestDialogProps) {
  const [kind, setKind] = useState<NewKind>('w9');
  const [vendorQ, setVendorQ] = useState('');
  const vq = useDebounce(vendorQ, 250);
  const [vendorId, setVendorId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [renewal, setRenewal] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setBusy(false);
  }, [open]);

  const isVendor = kind === 'w9' || kind === 'coi';
  const isMember = kind === 'approval_nudge';
  const { data: rec, isLoading: recLoading } = useQuery<RecipientsResponse>(open ? '/api/requests/recipients' : null, { q: vq || undefined }, { scope: false });
  const vendor = useMemo(() => rec?.vendors.find((v) => v.id === vendorId) ?? null, [rec, vendorId]);

  useEffect(() => {
    if (vendor && !email) setEmail(vendor.email ?? '');
    // only when the vendor changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);

  const help = KINDS.find((k) => k.value === kind)?.help;

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (isVendor && !vendorId) e.vendor = 'Pick the vendor.';
    if (isMember && !memberId) e.member = 'Pick the teammate.';
    if (!isVendor && !title.trim()) e.title = 'Say what you need.';
    if (!isMember && email && !EMAIL_RE.test(email.trim())) e.email = 'That email address doesn’t look right.';
    if (!isMember && !email.trim()) e.email = isVendor ? 'This vendor has no email on file — add one to send the request.' : 'Add an email address.';
    if (kind === 'coi' && renewal && !dueDate) e.dueDate = 'When does the current certificate expire?';
    return e;
  }

  async function submit() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      kind,
      location_id: isVendor ? null : locationId,
      vendor_id: isVendor ? vendorId : undefined,
      renewal: kind === 'coi' ? renewal : undefined,
      due_date: dueDate || undefined,
      title: isVendor ? undefined : title.trim(),
      message: message.trim() || undefined,
      recipient_type: isMember ? 'member' : isVendor ? 'vendor_contact' : 'email',
      recipient_membership_id: isMember ? memberId : undefined,
      recipient_email: isMember ? undefined : email.trim(),
      recipient_name: isMember || isVendor ? undefined : name.trim() || undefined,
      recipient_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const res = await api.post<Created>('/api/requests', body);
    setBusy(false);
    if (res.error) {
      const fieldErrors = res.error.details ? Object.fromEntries(Object.entries(res.error.details).map(([k, v]) => [k, v[0] ?? 'Check this field.'])) : {};
      setErrors({ ...fieldErrors, form: res.error.error });
      return;
    }
    if (!res.data) return;
    toast(res.data.created ? 'Request created. The first ask goes out on the next cycle (within 15 minutes) unless it’s quiet hours.' : 'There was already an open request for this — showing it.');
    onCreated(res.data.request.id);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New request"
      dismissOnScrim={false}
      footNote={!isVendor && clientName ? `For ${clientName}` : isVendor ? 'Vendor documents cover every client' : undefined}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create request'}
          </Button>
        </>
      }
    >
      <div className={s.formGrid}>
        {errors.form && (
          <InlineNotice tone="neg" title="Couldn’t create the request.">
            {errors.form}
          </InlineNotice>
        )}
        <Field label="What are you asking for?" help={help}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as NewKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>

        {isVendor && (
          <>
            <div className={s.twoCol}>
              <Field label="Find the vendor">
                <Input value={vendorQ} onChange={(e) => setVendorQ(e.target.value)} placeholder="Name or email" />
              </Field>
              <Field label="Vendor" error={errors.vendor ?? errors.vendor_id}>
                <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">{recLoading ? 'Loading…' : rec?.vendors.length ? 'Choose…' : 'No vendors match'}</option>
                  {(rec?.vendors ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.email ? '' : ' (no email)'}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {kind === 'coi' && (
              <div className={s.twoCol}>
                <Field label="Is this a renewal?">
                  <Select value={renewal ? 'yes' : 'no'} onChange={(e) => setRenewal(e.target.value === 'yes')}>
                    <option value="no">No — they have none on file</option>
                    <option value="yes">Yes — the current one is expiring</option>
                  </Select>
                </Field>
                {renewal && (
                  <Field label="Current certificate expires" error={errors.dueDate ?? errors.due_date}>
                    <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  </Field>
                )}
              </div>
            )}
          </>
        )}

        {isMember && (
          <Field label="Teammate" error={errors.member ?? errors.recipient_membership_id}>
            <Select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">{recLoading ? 'Loading…' : 'Choose…'}</option>
              {(rec?.members ?? []).map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                  {m.email ? ` · ${m.email}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {!isVendor && (
          <Field label="Title (the email subject)" error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={kind === 'approval_nudge' ? 'Approve the Oct 30 pay run' : 'Is the $412.18 Home Depot charge for the Ankeny job?'} />
          </Field>
        )}

        {!isMember && (
          <div className={s.twoCol}>
            {!isVendor && (
              <Field label="Their name (optional)">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
              </Field>
            )}
            <Field label="Email" error={errors.email ?? errors.recipient_email} help={isVendor && vendor?.email ? 'From the vendor record' : undefined}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
            </Field>
          </div>
        )}

        <Field label={isVendor ? 'Add a note (optional)' : 'Details (optional)'} help="Shown in the email under the title.">
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} rows={3} />
        </Field>

        {!isVendor && !isMember && kind !== 'client_question' && (
          <Field label="Needed by (optional)">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
