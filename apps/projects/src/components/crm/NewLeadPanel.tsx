'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Drawer, Field, Input, MoneyInput, PanelSection, Select, Textarea, toast } from '@meritbooks/merit-ui';
import { LEAD_SOURCES } from '@/lib/crm/types';
import { NewLeadBody } from '@/lib/crm/schemas';
import { checkDecision, decisionBody, type MatchCandidate, type MatchDecision } from '@/lib/parties/match';
import { MatchAtTheDoor, useDoorMatch } from './MatchAtTheDoor';
import { fieldErrors, postToDoor } from './door-fetch';
import './crm.css';

export interface CompanyOption {
  id: string;
  name: string;
}

export interface OwnerChoice {
  membershipId: string;
  name: string;
}

export interface NewLeadPanelProps {
  open: boolean;
  onClose: () => void;
  companies: ReadonlyArray<CompanyOption>;
  defaultCompanyId: string | null;
  owners: ReadonlyArray<OwnerChoice>;
  me: string | null;
  /** Draw the value field (projects.contract_value). */
  showValue: boolean;
}

interface Form {
  companyId: string;
  title: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
  source: string;
  sourceDetail: string;
  campaign: string;
  valueCents: number | null;
  expectedCloseOn: string;
  nextStep: string;
  nextStepOn: string;
  ownerId: string;
  notes: string;
}

const t = (s: string) => s.trim() || null;

/**
 * New lead (BP-39/40/44): who, what, where, how they found you. The person is matched against
 * the shared master as it is typed (matching at the door), so a customer Books already knows is
 * linked, not created twice. Saves with ⌘↵.
 */
export function NewLeadPanel({ open, onClose, companies, defaultCompanyId, owners, me, showValue }: NewLeadPanelProps) {
  const router = useRouter();
  const blank: Form = useMemo(() => ({
    companyId: defaultCompanyId ?? companies[0]?.id ?? '', title: '', name: '', firstName: '', lastName: '', email: '', phone: '',
    line1: '', city: '', state: '', zip: '', source: '', sourceDetail: '', campaign: '', valueCents: null, expectedCloseOn: '',
    nextStep: 'Call back', nextStepOn: '', ownerId: me ?? '', notes: '',
  }), [defaultCompanyId, companies, me]);
  const [f, setF] = useState<Form>(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<MatchDecision | null>(null);
  const [conflict, setConflict] = useState<MatchCandidate[] | null>(null);
  const [doorProblem, setDoorProblem] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const personName = f.name.trim() || [f.firstName, f.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
  const address = [f.line1, f.city, [f.state, f.zip].filter(Boolean).join(' ')].map((s) => s.trim()).filter(Boolean).join(', ');
  const door = useDoorMatch('customer', { name: personName, email: f.email, phone: f.phone, address }, conflict);
  const hasPerson = !!(personName || f.email.trim() || f.phone.trim());

  const close = () => {
    setF(blank);
    setErr({});
    setDecision(null);
    setConflict(null);
    setDoorProblem(null);
    onClose();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = {
      companyId: f.companyId, title: f.title, source: t(f.source), sourceDetail: t(f.sourceDetail), campaign: t(f.campaign),
      ownerMembershipId: f.ownerId || null, valueCents: showValue ? f.valueCents : null, expectedCloseOn: t(f.expectedCloseOn),
      nextStep: t(f.nextStep), nextStepOn: t(f.nextStepOn), notes: t(f.notes),
      customer: hasPerson ? { name: t(f.name), firstName: t(f.firstName), lastName: t(f.lastName), email: t(f.email), phone: t(f.phone), match: decisionBody(decision) } : null,
      site: f.line1.trim() ? { line1: t(f.line1), city: t(f.city), state: t(f.state), zip: t(f.zip) } : null,
    };
    const parsed = NewLeadBody.safeParse(body);
    const e2: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) e2[i.path.join('.')] ??= i.message;
    if (!hasPerson) e2.person = 'Add a name, an email or a phone so someone can follow up.';
    const check = hasPerson ? checkDecision(door.verdict, decision, 'customer') : { ok: true as const };
    setDoorProblem(check.ok ? null : check.message);
    setErr(e2);
    if (Object.keys(e2).length || !check.ok) return;
    setBusy(true);
    const r = await postToDoor<{ lead: { id: string }; customer: { id: string; existing: boolean } | null }>('/api/crm/leads', parsed.data);
    setBusy(false);
    if (r.kind === 'match') {
      setConflict(r.candidates);
      setDoorProblem(r.message);
      return;
    }
    if (r.kind === 'error') {
      setErr({ ...fieldErrors(r.error), _: r.error.error });
      return;
    }
    toast(r.data.customer?.existing ? 'Added the lead to an existing customer' : 'Added the lead');
    close();
    router.push(`/leads/${r.data.lead.id}`);
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      width={520}
      eyebrow="Leads"
      title="New lead"
      foot={
        <div className="btn-row">
          <Button variant="primary" chord="mod+enter" bindChord={open} disabled={busy} aria-busy={busy || undefined} onClick={() => void submit()}>Add lead</Button>
          <Button variant="quiet" disabled={busy} onClick={close}>Cancel</Button>
        </div>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <PanelSection title="The work">
          {companies.length > 1 && (
            <Field label="Company" error={err.companyId}>
              <Select value={f.companyId} onChange={(e) => set('companyId', e.target.value)}>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="What is the work?" error={err.title}>
            <Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} placeholder="Kitchen remodel, AC replacement, 40-unit flooring bid" autoFocus />
          </Field>
          {showValue && (
            <div className="mp-form-2">
              <Field label="Estimated value" help="Optional" error={err.valueCents}>
                <MoneyInput valueCents={f.valueCents} onChangeCents={(c) => set('valueCents', c)} />
              </Field>
              <Field label="Expected to close" error={err.expectedCloseOn}>
                <Input type="date" value={f.expectedCloseOn} onChange={(e) => set('expectedCloseOn', e.target.value)} />
              </Field>
            </div>
          )}
        </PanelSection>

        <PanelSection title="Who">
          <Field label="Customer or company name" help="Leave blank for a household; it is named for the person." error={err['customer.name']}>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />
          </Field>
          <div className="mp-form-2">
            <Field label="First name"><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} maxLength={100} /></Field>
            <Field label="Last name"><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} maxLength={100} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Email" error={err['customer.email']}><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={254} /></Field>
            <Field label="Phone" error={err['customer.phone']}><Input type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} /></Field>
          </div>
          {err.person && <span className="field-error" role="alert">{err.person}</span>}
          {hasPerson && <MatchAtTheDoor kind="customer" verdict={door.verdict} decision={decision} onDecision={setDecision} loading={door.loading} error={door.error} problem={doorProblem} />}
        </PanelSection>

        <PanelSection title="Where">
          <Field label="Street address" help="Optional. Becomes the job site."><Input value={f.line1} onChange={(e) => set('line1', e.target.value)} maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="City"><Input value={f.city} onChange={(e) => set('city', e.target.value)} maxLength={100} /></Field>
            <div className="mp-form-2">
              <Field label="State"><Input value={f.state} onChange={(e) => set('state', e.target.value)} maxLength={40} /></Field>
              <Field label="ZIP"><Input value={f.zip} onChange={(e) => set('zip', e.target.value)} maxLength={20} /></Field>
            </div>
          </div>
        </PanelSection>

        <PanelSection title="How they found you">
          <div className="mp-form-2">
            <Field label="Source">
              <Select value={f.source} onChange={(e) => set('source', e.target.value)}>
                <option value="">Pick a source</option>
                {LEAD_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
            <Field label="Campaign" help="Optional"><Input value={f.campaign} onChange={(e) => set('campaign', e.target.value)} maxLength={100} /></Field>
          </div>
          <Field label="Source detail" help="Who referred them, which ad, which show"><Input value={f.sourceDetail} onChange={(e) => set('sourceDetail', e.target.value)} maxLength={200} /></Field>
        </PanelSection>

        <PanelSection title="Next step">
          <div className="mp-form-2">
            <Field label="Next step" error={err.nextStep}><Input value={f.nextStep} onChange={(e) => set('nextStep', e.target.value)} maxLength={300} /></Field>
            <Field label="By" error={err.nextStepOn}><Input type="date" value={f.nextStepOn} onChange={(e) => set('nextStepOn', e.target.value)} /></Field>
          </div>
          {owners.length > 0 && (
            <Field label="Owner">
              <Select value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
                <option value="">Unassigned</option>
                {owners.map((o) => <option key={o.membershipId} value={o.membershipId}>{o.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Notes" help="What they asked for, budget, timing. Saved as the first entry on the lead.">
            <Textarea rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={4000} />
          </Field>
        </PanelSection>
        {err._ && <p className="field-error" role="alert" style={{ padding: '0 16px' }}>{err._}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Drawer>
  );
}
