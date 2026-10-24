'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Check, Drawer, Field, Input, PanelSection, Textarea, api, toast } from '@meritbooks/merit-ui';
import { CONTACT_ROLES, CONTACT_ROLE_WORDS, type ContactRole, type ContactRow, type SiteRow } from '@/lib/crm/types';
import { ContactBody, SiteBody } from '@/lib/crm/schemas';
import { checkDecision, decisionBody, type MatchCandidate, type MatchDecision } from '@/lib/parties/match';
import { MatchAtTheDoor, useDoorMatch } from '@/components/crm/MatchAtTheDoor';
import { fieldErrors, postToDoor } from '@/components/crm/door-fetch';

interface ContactForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  roles: ContactRole[];
  isPrimary: boolean;
  canSign: boolean;
  canPay: boolean;
  smsConsent: boolean;
  emailConsent: boolean;
}

function fromContact(c: ContactRow | null): ContactForm {
  return {
    firstName: c?.first_name ?? '', lastName: c?.last_name ?? '', email: c?.email ?? '', phone: c?.phone ?? '', title: c?.title ?? '',
    roles: (c?.roles ?? []).filter((r): r is ContactRole => (CONTACT_ROLES as readonly string[]).includes(r)),
    isPrimary: c?.is_primary ?? false, canSign: c?.can_sign ?? false, canPay: c?.can_pay ?? false,
    smsConsent: c?.sms_consent ?? false, emailConsent: c?.email_consent ?? false,
  };
}

/** Add (matched at the door) or edit a contact on a customer (core.create_contact / core.contacts). */
export function ContactDrawer({ open, onClose, customerId, contact }: { open: boolean; onClose: () => void; customerId: string; contact: ContactRow | null }) {
  const router = useRouter();
  const [f, setF] = useState<ContactForm>(fromContact(contact));
  const [decision, setDecision] = useState<MatchDecision | null>(null);
  const [conflict, setConflict] = useState<MatchCandidate[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(fromContact(contact));
      setDecision(null);
      setConflict(null);
      setProblem(null);
      setErr({});
    }
  }, [open, contact]);
  const isNew = !contact;
  const name = [f.firstName, f.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
  const door = useDoorMatch('contact', isNew ? { name, email: f.email, phone: f.phone } : {}, conflict);
  const set = <K extends keyof ContactForm>(k: K, v: ContactForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const parsed = ContactBody.safeParse({ ...f, firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, title: f.title });
    if (!parsed.success) {
      const e: Record<string, string> = {};
      for (const i of parsed.error.issues) e[i.path.join('.') || 'firstName'] ??= i.message;
      return setErr(e);
    }
    setErr({});
    if (isNew) {
      const check = checkDecision(door.verdict, decision, 'contact');
      setProblem(check.ok ? null : check.message);
      if (!check.ok) return;
    }
    setBusy(true);
    const r = isNew
      ? await postToDoor<{ contact: { id: string }; existing: boolean; elsewhere: boolean }>(`/api/customers/${customerId}/contacts`, { contact: parsed.data, match: decisionBody(decision) })
      : await postToDoor<{ ok: true }>(`/api/customers/${customerId}/contacts/${contact!.id}`, parsed.data, 'PATCH');
    setBusy(false);
    if (r.kind === 'match') {
      setConflict(r.candidates);
      setProblem(r.message);
      return;
    }
    if (r.kind === 'error') return setErr({ ...fieldErrors(r.error), _: r.error.error });
    const d = r.data as { existing?: boolean; elsewhere?: boolean };
    toast(isNew ? (d.elsewhere ? `${name || 'That person'} is already a contact on another customer` : d.existing ? `${name || 'That contact'} was already on file` : `Added ${name || 'the contact'}`) : `Saved ${name || 'the contact'}`);
    onClose();
    router.refresh();
  };

  return (
    <Drawer open={open} onClose={onClose} eyebrow="Contact" title={isNew ? 'New contact' : `Edit ${name || 'contact'}`} width={460}
      foot={<div className="btn-row"><Button variant="primary" chord="mod+enter" bindChord={open} disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>{isNew ? 'Add contact' : 'Save'}</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div>}>
      <PanelSection>
        <div className="mp-form-2">
          <Field label="First name" error={err.firstName}><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} maxLength={100} autoFocus /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} maxLength={100} /></Field>
        </div>
        <div className="mp-form-2">
          <Field label="Email" error={err.email}><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={254} /></Field>
          <Field label="Phone"><Input type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} /></Field>
        </div>
        <Field label="Title"><Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={100} placeholder="Homeowner, AP clerk, site super" /></Field>
        {isNew && <MatchAtTheDoor kind="contact" verdict={door.verdict} decision={decision} onDecision={setDecision} loading={door.loading} error={door.error} problem={problem} />}
      </PanelSection>
      <PanelSection title="Role on this customer">
        <div className="crm-filters" role="group" aria-label="Roles">
          {CONTACT_ROLES.map((r) => (
            <button key={r} type="button" className="crm-filter" aria-pressed={f.roles.includes(r)} onClick={() => set('roles', f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r])}>{CONTACT_ROLE_WORDS[r]}</button>
          ))}
        </div>
        <Check label="Primary contact" checked={f.isPrimary} onChange={(e) => set('isPrimary', e.target.checked)} />
        <Check label="Signs contracts and change orders" checked={f.canSign} onChange={(e) => set('canSign', e.target.checked)} />
        <Check label="Pays invoices (Merit Books sends them here)" checked={f.canPay} onChange={(e) => set('canPay', e.target.checked)} />
      </PanelSection>
      <PanelSection title="Consent">
        <Check label="Agreed to texts" checked={f.smsConsent} onChange={(e) => set('smsConsent', e.target.checked)} />
        <Check label="Agreed to email" checked={f.emailConsent} onChange={(e) => set('emailConsent', e.target.checked)} />
        <span className="t-cap">Every follow-up and automated message honors these. Record consent only when the person gave it.</span>
        {err._ && <span className="field-error" role="alert">{err._}</span>}
      </PanelSection>
    </Drawer>
  );
}

interface SiteForm {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  accessNotes: string;
  taxJurisdiction: string;
}

function fromSite(s: SiteRow | null): SiteForm {
  return {
    name: s?.name ?? '', line1: s?.address_line1 ?? '', line2: s?.address_line2 ?? '', city: s?.city ?? '', state: s?.state ?? '', zip: s?.zip ?? '',
    accessNotes: s?.access_notes ?? '', taxJurisdiction: s?.tax_jurisdiction ?? '',
  };
}

/** Add or edit a site (core.create_site matches the address first; edits go to core.sites). */
export function SiteDrawer({ open, onClose, customerId, site, companyId }: { open: boolean; onClose: () => void; customerId: string; site: SiteRow | null; companyId: string | null }) {
  const router = useRouter();
  const [f, setF] = useState<SiteForm>(fromSite(site));
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(fromSite(site));
      setErr({});
    }
  }, [open, site]);
  const set = <K extends keyof SiteForm>(k: K, v: SiteForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const parsed = SiteBody.safeParse({ ...f, companyId });
    if (!parsed.success) {
      const e: Record<string, string> = {};
      for (const i of parsed.error.issues) e[i.path.join('.')] ??= i.message;
      return setErr(e);
    }
    setBusy(true);
    const r = site ? await api.patch<{ ok: true }>(`/api/customers/${customerId}/sites/${site.id}`, parsed.data) : await api.post<{ site: { id: string } }>(`/api/customers/${customerId}/sites`, parsed.data);
    setBusy(false);
    if (r.error) return setErr({ ...Object.fromEntries(Object.entries(r.error.details ?? {}).map(([k, m]) => [k, m[0] ?? ''])), _: r.error.error });
    toast(site ? 'Saved the site' : 'Added the site');
    onClose();
    router.refresh();
  };
  return (
    <Drawer open={open} onClose={onClose} eyebrow="Site" title={site ? 'Edit site' : 'New site'} width={440}
      foot={<div className="btn-row"><Button variant="primary" chord="mod+enter" bindChord={open} disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>{site ? 'Save' : 'Add site'}</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div>}>
      <PanelSection>
        <Field label="Site name" help="Optional: Lake house, Store 12"><Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} /></Field>
        <Field label="Street address" error={err.line1}><Input value={f.line1} onChange={(e) => set('line1', e.target.value)} maxLength={200} autoFocus /></Field>
        <Field label="Unit, suite"><Input value={f.line2} onChange={(e) => set('line2', e.target.value)} maxLength={200} /></Field>
        <div className="mp-form-2">
          <Field label="City"><Input value={f.city} onChange={(e) => set('city', e.target.value)} maxLength={100} /></Field>
          <div className="mp-form-2">
            <Field label="State"><Input value={f.state} onChange={(e) => set('state', e.target.value)} maxLength={40} /></Field>
            <Field label="ZIP"><Input value={f.zip} onChange={(e) => set('zip', e.target.value)} maxLength={20} /></Field>
          </div>
        </div>
        <Field label="Access notes" help="Gate codes, parking, pets, who lets the crew in"><Textarea rows={3} value={f.accessNotes} onChange={(e) => set('accessNotes', e.target.value)} maxLength={1000} /></Field>
        <Field label="Tax jurisdiction" help="Merit Books uses it for sales tax"><Input value={f.taxJurisdiction} onChange={(e) => set('taxJurisdiction', e.target.value)} maxLength={100} /></Field>
        {err._ && <span className="field-error" role="alert">{err._}</span>}
      </PanelSection>
    </Drawer>
  );
}
