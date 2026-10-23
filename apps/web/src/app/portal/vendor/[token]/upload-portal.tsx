'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Button, Check, Field, InlineNotice, Input, Pip, Select, Tag } from '@meritbooks/merit-ui';
import type { PortalCheck, PortalItem, PortalView } from '@/lib/vendor-compliance/portal';

/**
 * Public vendor portal UI (no app shell, no session). 390-first: one column, 44px targets,
 * camera-friendly file input. Each requested item says what is needed and why; a W-9 can be
 * filled and e-signed right here (TIN masked, entered twice, never shown back in full); a
 * certificate upload is read by AI and every requirement check is shown back in words.
 */

type DocKind = 'W9' | 'COI' | 'BANKING';
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const MAX_BYTES = 15 * 1024 * 1024;
const TAP = { minHeight: 44 } as const;

const ENTITY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'INDIVIDUAL_SOLE_PROP', label: 'Individual / sole proprietor / single-member LLC' },
  { value: 'C_CORP', label: 'C corporation' },
  { value: 'S_CORP', label: 'S corporation' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
  { value: 'TRUST_ESTATE', label: 'Trust / estate' },
  { value: 'LLC', label: 'Limited liability company (LLC)' },
  { value: 'OTHER', label: 'Other' },
];

const STATE_LOOK: Record<PortalItem['state'], { pip: 'open' | 'ready' | 'risk' | 'blocked' | 'track'; word: string }> = {
  needed: { pip: 'blocked', word: 'Needed' },
  received: { pip: 'open', word: 'Received' },
  checked: { pip: 'open', word: 'Checked' },
  accepted: { pip: 'ready', word: 'Accepted' },
  rejected: { pip: 'blocked', word: 'Please resend' },
  on_file: { pip: 'ready', word: 'On file' },
};

function checkPip(w: PortalCheck['word']): 'ready' | 'blocked' | 'risk' | 'open' {
  return w === 'Meets' ? 'ready' : w === 'Expiring soon' ? 'risk' : w === 'Waiting for review' ? 'open' : 'blocked';
}

export function VendorPortalClient({ token, view, certification }: { token: string; view: PortalView; certification: string[] }) {
  const [items, setItems] = useState(view.items);
  const open = items.filter((i) => i.kind !== 'BANKING' && i.state !== 'accepted' && i.state !== 'on_file').length;
  return (
    <div>
      <h1 className="t-title" style={{ margin: '4px 0 0' }}>
        {view.allDone ? 'You’re all set' : `${view.companyName} needs ${open === 1 ? 'one thing' : `${open} things`} from you`}
      </h1>
      <p className="ink-2" style={{ marginTop: 8 }}>
        {view.vendorName ? <>For <strong>{view.vendorName}</strong>. </> : null}
        {view.allDone ? 'Everything requested has been accepted. Thank you.' : 'Takes about three minutes. No account or password needed.'}
      </p>
      {view.renewalDate && (
        <p className="t-cap" style={{ marginTop: 8 }}>
          Your certificate on file runs to <span className="tnum">{view.renewalDate}</span>. We’ll remind you before then.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 20 }}>
        {items.map((it) => (
          <ItemCard key={it.kind} token={token} item={it} certification={certification} onUpdate={(next) => setItems((xs) => xs.map((x) => (x.kind === next.kind ? next : x)))} />
        ))}
      </div>
      <p className="t-cap" style={{ marginTop: 24 }}>
        PDF, JPG or PNG up to 15 MB. Your documents go only to {view.companyName} and are stored encrypted. Questions? Reply to the email that sent you this link.
      </p>
    </div>
  );
}

function ItemCard({ token, item, certification, onUpdate }: { token: string; item: PortalItem; certification: string[]; onUpdate: (i: PortalItem) => void }) {
  const [mode, setMode] = useState<'idle' | 'form'>('idle');
  const look = STATE_LOOK[item.state];
  const done = item.state === 'accepted' || item.state === 'on_file';
  return (
    <section aria-label={item.label} style={{ border: '1px solid var(--line-2)', background: 'var(--white)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <h2 className="t-head" style={{ margin: 0 }}>{item.label}</h2>
          <p className="t-cap" style={{ marginTop: 2 }}>{item.why}</p>
        </div>
        {item.kind !== 'BANKING' && (
          <span className="mb-sev" style={{ whiteSpace: 'nowrap' }}>
            <Pip kind={look.pip} />
            {look.word}
          </span>
        )}
      </div>

      {item.asks.length > 0 && !done && (
        <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
          {item.asks.map((a) => (
            <li key={a} className="ink-2">{a}</li>
          ))}
        </ul>
      )}

      {item.status && <p className="ink-2" style={{ marginTop: 12 }} aria-live="polite">{item.status}</p>}
      {item.rejectedReason && (
        <InlineNotice tone="neg" title="What needs fixing">
          {item.rejectedReason}
        </InlineNotice>
      )}
      {item.checks.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {item.checks.map((c) => (
            <li key={`${c.label}:${c.reason}`} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="mb-sev" style={{ minWidth: 112 }}>
                <Pip kind={checkPip(c.word)} />
                {c.word}
              </span>
              <span>
                <span className="t-ui">{c.label}</span>
                <span className="t-cap" style={{ display: 'block' }}>{c.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {item.kind === 'W9' && mode === 'form' ? (
        <W9Form token={token} certification={certification} onCancel={() => setMode('idle')} onDone={(msg, last4) => { setMode('idle'); onUpdate({ ...item, state: 'received', status: msg, checks: [{ label: 'Form W-9', word: 'Waiting for review', reason: `Signed online; taxpayer ID ending ${last4}.` }], rejectedReason: null }); }} />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {item.kind === 'W9' && item.fillHere && (
            <Button variant={done ? 'default' : 'primary'} style={TAP} onClick={() => setMode('form')}>
              {done ? 'Update my W-9 online' : 'Fill in my W-9 online'}
            </Button>
          )}
          <Uploader token={token} kind={item.kind} primary={item.kind !== 'W9' && !done} label={item.kind === 'W9' ? 'Upload a signed W-9' : item.kind === 'COI' ? (done ? 'Upload a renewed certificate' : 'Upload the certificate') : 'Upload a voided check or bank letter'} onResult={(next, message) => onUpdate(next ? next : { ...item, state: item.kind === 'BANKING' ? item.state : 'received', status: message, checks: [] })} />
        </div>
      )}
      {item.kind === 'COI' && !done && <p className="t-cap" style={{ marginTop: 8 }}>Not sure what to send? Forward the email that brought you here to your insurance agent — the link works for them too.</p>}
    </section>
  );
}

function Uploader({ token, kind, label, primary, onResult }: { token: string; kind: DocKind; label: string; primary: boolean; onResult: (item: PortalItem | null, message: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phone, setPhone] = useState('');

  const send = async (file: File) => {
    setErr(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) return setErr('Upload a PDF, JPG or PNG.');
    if (file.size <= 0) return setErr('That file is empty.');
    if (file.size > MAX_BYTES) return setErr('That file is larger than 15 MB.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_kind', kind);
      if (kind === 'BANKING' && phone.trim()) fd.append('contact_phone', phone.trim());
      const res = await fetch(`/api/portal/vendor/${encodeURIComponent(token)}/upload`, { method: 'POST', body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string | null; item?: PortalItem };
      if (!res.ok || body.error) {
        setErr(body.error ?? 'Upload failed. Please try again.');
        return;
      }
      onResult(body.item ?? null, body.message ?? 'Received.');
    } catch {
      setErr('Network problem. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      {kind === 'BANKING' && (
        <Field label="Your phone number (optional)" help="To confirm, we call the number we already have on file for you — not one entered here.">
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
        </Field>
      )}
      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void send(f);
          e.target.value = '';
        }}
      />
      <Button variant={primary ? 'primary' : 'default'} icon="upload" style={{ ...TAP, marginTop: kind === 'BANKING' ? 8 : 0 }} disabled={busy} onClick={() => ref.current?.click()} aria-busy={busy}>
        {busy ? (kind === 'COI' ? 'Uploading and reading…' : 'Uploading…') : label}
      </Button>
      {busy && kind === 'COI' && <p className="t-cap" role="status" style={{ marginTop: 4 }}>Checking it against what’s required — about 15 seconds.</p>}
      {err && (
        <InlineNotice tone="neg" title="Not sent" role="alert">
          {err}
        </InlineNotice>
      )}
    </div>
  );
}

interface W9State {
  legal_name: string;
  business_name: string;
  entity_type: string;
  llc_tax_class: string;
  exempt_payee_code: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  tin_type: 'SSN' | 'EIN';
  tin: string;
  tin_confirm: string;
  signer_name: string;
  signature: string;
  certify: boolean;
  esign_consent: boolean;
}

const BLANK: W9State = {
  legal_name: '', business_name: '', entity_type: '', llc_tax_class: '', exempt_payee_code: '', address_line1: '', address_line2: '', city: '', state: '', zip: '',
  tin_type: 'EIN', tin: '', tin_confirm: '', signer_name: '', signature: '', certify: false, esign_consent: false,
};

function W9Form({ token, certification, onCancel, onDone }: { token: string; certification: string[]; onCancel: () => void; onDone: (message: string, last4: string) => void }) {
  const [f, setF] = useState<W9State>(BLANK);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [top, setTop] = useState<string | null>(null);
  const set = (p: Partial<W9State>) => setF((x) => ({ ...x, ...p }));
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 9);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTop(null);
    const errs: Record<string, string> = {};
    if (f.legal_name.trim().length < 2) errs.legal_name = 'Enter the name shown on your tax return.';
    if (!f.entity_type) errs.entity_type = 'Pick your federal tax classification.';
    if (f.entity_type === 'LLC' && !f.llc_tax_class) errs.llc_tax_class = 'Pick how the LLC is taxed.';
    if (f.address_line1.trim().length < 3) errs.address_line1 = 'Enter your street address.';
    if (f.city.trim().length < 2) errs.city = 'Enter your city.';
    if (!/^[A-Za-z]{2}$/.test(f.state.trim())) errs.state = 'Two-letter state, like IA.';
    if (!/^\d{5}(-\d{4})?$/.test(f.zip.trim())) errs.zip = 'ZIP like 50309.';
    if (digits(f.tin).length !== 9) errs.tin = 'Enter all 9 digits.';
    if (digits(f.tin_confirm) !== digits(f.tin)) errs.tin_confirm = 'The two entries do not match.';
    if (f.signer_name.trim().length < 2) errs.signer_name = 'Enter your name.';
    if (f.signature.trim().toLowerCase() !== f.signer_name.trim().toLowerCase()) errs.signature = 'Type your name exactly as above to sign.';
    if (!f.certify) errs.certify = 'You must certify to sign.';
    if (!f.esign_consent) errs.esign_consent = 'Agree to sign electronically.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/vendor/${encodeURIComponent(token)}/w9`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, llc_tax_class: f.entity_type === 'LLC' ? f.llc_tax_class : null, state: f.state.trim().toUpperCase() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string>; message?: string; tin_last4?: string };
      if (!res.ok || body.error) {
        setErrors(body.fields ?? {});
        setTop(body.error ?? 'Could not send the form.');
        return;
      }
      setF(BLANK); // clear the TIN from memory
      onDone(body.message ?? 'Signed and received.', body.tin_last4 ?? '••••');
    } catch {
      setTop('Network problem. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate style={{ display: 'grid', gap: 12, marginTop: 16 }} aria-label="Form W-9">
      <Field label="1. Name (as shown on your income tax return)" error={errors.legal_name}><Input value={f.legal_name} onChange={(e) => set({ legal_name: e.target.value })} autoComplete="organization" /></Field>
      <Field label="2. Business name / disregarded entity name, if different"><Input value={f.business_name} onChange={(e) => set({ business_name: e.target.value })} /></Field>
      <Field label="3. Federal tax classification" error={errors.entity_type}>
        <Select value={f.entity_type} onChange={(e) => set({ entity_type: e.target.value })} style={TAP}>
          <option value="">Choose…</option>
          {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </Field>
      {f.entity_type === 'LLC' && (
        <Field label="LLC tax classification" error={errors.llc_tax_class}>
          <Select value={f.llc_tax_class} onChange={(e) => set({ llc_tax_class: e.target.value })} style={TAP}>
            <option value="">Choose…</option>
            <option value="C">C corporation</option>
            <option value="S">S corporation</option>
            <option value="P">Partnership</option>
          </Select>
        </Field>
      )}
      <Field label="4. Exempt payee code (if any)" help="Most businesses leave this blank."><Input value={f.exempt_payee_code} onChange={(e) => set({ exempt_payee_code: e.target.value })} style={{ maxWidth: 120 }} /></Field>
      <Field label="5. Address" error={errors.address_line1}><Input value={f.address_line1} onChange={(e) => set({ address_line1: e.target.value })} autoComplete="address-line1" /></Field>
      <Field label="Address line 2"><Input value={f.address_line2} onChange={(e) => set({ address_line2: e.target.value })} autoComplete="address-line2" /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr', gap: 8 }}>
        <Field label="6. City" error={errors.city}><Input value={f.city} onChange={(e) => set({ city: e.target.value })} autoComplete="address-level2" /></Field>
        <Field label="State" error={errors.state}><Input value={f.state} maxLength={2} onChange={(e) => set({ state: e.target.value })} autoComplete="address-level1" /></Field>
        <Field label="ZIP" error={errors.zip}><Input value={f.zip} inputMode="numeric" onChange={(e) => set({ zip: e.target.value })} autoComplete="postal-code" /></Field>
      </div>
      <Field label="Part I. Taxpayer identification number">
        <Select value={f.tin_type} onChange={(e) => set({ tin_type: e.target.value as 'SSN' | 'EIN' })} style={TAP}>
          <option value="EIN">Employer identification number (EIN)</option>
          <option value="SSN">Social Security number (SSN)</option>
        </Select>
      </Field>
      <Field label={f.tin_type} error={errors.tin}>
        <Input type={show ? 'text' : 'password'} inputMode="numeric" autoComplete="off" value={f.tin} onChange={(e) => set({ tin: digits(e.target.value) })} className="tnum" />
      </Field>
      <Field label={`Re-enter ${f.tin_type}`} error={errors.tin_confirm}>
        <Input type={show ? 'text' : 'password'} inputMode="numeric" autoComplete="off" value={f.tin_confirm} onChange={(e) => set({ tin_confirm: digits(e.target.value) })} className="tnum" />
      </Field>
      <Check label="Show what I typed" checked={show} onChange={(e) => setShow(e.target.checked)} />

      <div style={{ border: '1px solid var(--line)', padding: 12, background: 'var(--canvas)' }}>
        <div className="eyebrow">Part II. Certification</div>
        {certification.map((p) => (
          <p key={p} className="t-cap" style={{ marginTop: 6 }}>{p}</p>
        ))}
      </div>
      <Check label="I certify the statements above under penalties of perjury." checked={f.certify} onChange={(e) => set({ certify: e.target.checked })} />
      {errors.certify && <span className="field-error">{errors.certify}</span>}
      <Check label="I agree to sign this form electronically. My typed name is my signature." checked={f.esign_consent} onChange={(e) => set({ esign_consent: e.target.checked })} />
      {errors.esign_consent && <span className="field-error">{errors.esign_consent}</span>}
      <Field label="Your name" error={errors.signer_name}><Input value={f.signer_name} onChange={(e) => set({ signer_name: e.target.value })} autoComplete="name" /></Field>
      <Field label="Signature — type your name again" error={errors.signature}><Input value={f.signature} onChange={(e) => set({ signature: e.target.value })} /></Field>
      <p className="t-cap"><Tag>Secure</Tag> Your taxpayer ID is encrypted when it reaches us and is never shown back in full.</p>
      {top && <InlineNotice tone="neg" title="Not sent" role="alert">{top}</InlineNotice>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button type="submit" variant="primary" style={TAP} disabled={busy}>{busy ? 'Signing…' : 'Sign and send W-9'}</Button>
        <Button variant="quiet" style={TAP} onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
