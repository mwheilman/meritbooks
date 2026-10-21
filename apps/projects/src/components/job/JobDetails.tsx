'use client';

import { useState } from 'react';
import { Button, Field, Input, KV } from '@meritbooks/merit-ui';
import { CustomerPicker, customerPending, customerPendingMessage, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from './useAction';

export interface JobDetailsProps {
  jobId: string;
  companyId: string;
  customerId: string | null;
  customerName: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  facts: Array<{ term: string; value: string }>;
}

/** Customer and planned dates (the has_customer guard is fixed here). */
export function JobDetails(p: JobDetailsProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [customer, setCustomer] = useState<CustomerValue>({ id: p.customerId, name: p.customerName ?? '' });
  const [start, setStart] = useState(p.plannedStart ?? '');
  const [finish, setFinish] = useState(p.plannedFinish ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [custErr, setCustErr] = useState<string | null>(null);
  // A legacy job may carry only a provisional customer name (pre-1108). Leaving it untouched
  // keeps it; changing the customer always links a real customer.
  const customerChanged = customer.id !== p.customerId || (!customer.id && customer.name.trim() !== (p.customerName ?? '').trim());

  const save = async () => {
    if (start && finish && finish < start) {
      setErr('The finish date is before the start date.');
      return;
    }
    setErr(null);
    if (customerChanged && customerPending(customer)) {
      setCustErr(customerPendingMessage(customer));
      return;
    }
    setCustErr(null);
    const res = await run('details', 'patch', `/api/jobs/${p.jobId}`, {
      ...(customerChanged ? { customerId: customer.id } : {}),
      plannedStart: start || null,
      plannedFinish: finish || null,
    }, 'Saved job details');
    if (!res.error) setEditing(false);
  };

  if (!editing) {
    return (
      <div id="customer">
        <KV
          items={[
            { term: v.customer, value: p.customerName ?? '—' },
            { term: 'Planned start', value: p.plannedStart ?? '—' },
            { term: 'Planned finish', value: p.plannedFinish ?? '—' },
            { term: 'Started', value: p.actualStart ?? '—' },
            ...p.facts.map((f) => ({ term: f.term, value: f.value })),
          ]}
        />
        {!readOnly && (
          <div className="btn-row" style={{ marginTop: 16 }}>
            <Button onClick={() => setEditing(true)}>{p.customerName ? 'Edit details' : `Choose the ${v.customer.toLowerCase()}`}</Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <form id="customer" className="mp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label={v.customer} error={custErr ?? undefined} help={!p.customerId && p.customerName && !customerChanged ? 'This name is not linked to a customer yet. Pick or add the customer to link it.' : undefined}>
        <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setCustErr(null); }} companyId={p.companyId} invalid={!!custErr} />
      </Field>
      <div className="mp-form-2">
        <Field label="Planned start"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Planned finish" error={err ?? undefined}><Input type="date" value={finish} onChange={(e) => setFinish(e.target.value)} /></Field>
      </div>
      <div className="btn-row">
        <Button variant="primary" type="submit" disabled={busy === 'details'}>Save details</Button>
        <Button variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </form>
  );
}
