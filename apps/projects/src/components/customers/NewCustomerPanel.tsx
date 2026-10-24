'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Drawer, Field, Input, PanelSection, Select, toast } from '@meritbooks/merit-ui';
import { CUSTOMER_SHARED_NOTE } from '@/lib/pm/parties/schemas';
import { checkDecision, decisionBody, type MatchCandidate, type MatchDecision } from '@/lib/parties/match';
import { MatchAtTheDoor, useDoorMatch } from '@/components/crm/MatchAtTheDoor';
import { fieldErrors, postToDoor } from '@/components/crm/door-fetch';

/**
 * New customer on the shared master, matched at the door as it is typed: an exact email or phone
 * already in Merit is used by default; adding a second one needs a typed reason.
 */
export function NewCustomerPanel({ open, onClose, companies, defaultCompanyId }: {
  open: boolean;
  onClose: () => void;
  companies: ReadonlyArray<{ id: string; name: string }>;
  defaultCompanyId: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? '');
  const [decision, setDecision] = useState<MatchDecision | null>(null);
  const [conflict, setConflict] = useState<MatchCandidate[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const door = useDoorMatch('customer', { name, email, phone }, conflict);

  const reset = () => {
    setName(''); setEmail(''); setPhone(''); setFirst(''); setLast('');
    setDecision(null); setConflict(null); setProblem(null); setErr({});
    onClose();
  };

  const save = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Give the customer a name.';
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = 'Enter an email like name@company.com.';
    const check = checkDecision(door.verdict, decision, 'customer');
    setErr(e);
    setProblem(check.ok ? null : check.message);
    if (Object.keys(e).length || !check.ok) return;
    setBusy(true);
    const r = await postToDoor<{ customer: { id: string; name: string }; existing: boolean }>('/api/customers', {
      name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, companyId: companyId || null,
      contactFirst: first.trim() || null, contactLast: last.trim() || null, match: decisionBody(decision),
    });
    setBusy(false);
    if (r.kind === 'match') {
      setConflict(r.candidates);
      setProblem(r.message);
      return;
    }
    if (r.kind === 'error') {
      setErr({ ...fieldErrors(r.error), _: r.error.error });
      return;
    }
    toast(r.data.existing ? `Opened ${r.data.customer.name}, already on your list` : `Added ${r.data.customer.name}`);
    reset();
    router.push(`/customers/${r.data.customer.id}`);
  };

  return (
    <Drawer open={open} onClose={reset} eyebrow="Customers" title="New customer" width={480}
      foot={<div className="btn-row"><Button variant="primary" chord="mod+enter" bindChord={open} disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>Add customer</Button><Button variant="quiet" onClick={reset}>Cancel</Button></div>}>
      <PanelSection>
        <Field label="Customer name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus /></Field>
        <div className="mp-form-2">
          <Field label="Email" error={err.email}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} /></Field>
          <Field label="Phone" error={err.phone}><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} /></Field>
        </div>
        <div className="mp-form-2">
          <Field label="Contact first name"><Input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={100} /></Field>
          <Field label="Contact last name"><Input value={last} onChange={(e) => setLast(e.target.value)} maxLength={100} /></Field>
        </div>
        {companies.length > 1 && (
          <Field label="Company" help="Leave shared to use it across your companies.">
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">Shared</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <MatchAtTheDoor kind="customer" verdict={door.verdict} decision={decision} onDecision={setDecision} loading={door.loading} error={door.error} problem={problem} />
        <span className="t-cap">{CUSTOMER_SHARED_NOTE}</span>
        {err._ && <span className="field-error" role="alert">{err._}</span>}
      </PanelSection>
    </Drawer>
  );
}
