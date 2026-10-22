'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, MoneyInput, Panel, PanelSection, Select, api, toast, useEscapeKey } from '@meritbooks/merit-ui';
import type { JobTypeRow } from '@/lib/pm/types';
import { useMoneyVis, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { CustomerPicker, customerPending, customerPendingMessage, type CustomerValue } from './CustomerPicker';

export interface NewJobPanelProps {
  companies: ReadonlyArray<{ id: string; name: string }>;
  defaultCompanyId: string;
  jobTypes: ReadonlyArray<JobTypeRow>;
  onClose: () => void;
}

type Errors = Partial<Record<'companyId' | 'jobTypeKey' | 'name' | 'customerName' | 'contractCents' | 'startDate' | '_', string>>;

export function NewJobPanel({ companies, defaultCompanyId, jobTypes, onClose }: NewJobPanelProps) {
  const router = useRouter();
  const v = useVocab();
  const mv = useMoneyVis();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const types = useMemo(() => jobTypes.filter((t) => t.location_id === companyId), [jobTypes, companyId]);
  const [jobTypeKey, setJobTypeKey] = useState(types[0]?.key ?? '');
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState<CustomerValue>({ id: null, name: '' });
  const [contract, setContract] = useState<number | null>(null);
  const [start, setStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  useEscapeKey(onClose, !busy, 'New job panel');

  const submit = async () => {
    const next: Errors = {};
    if (!name.trim()) next.name = `Give the ${lower(v.job)} a name.`;
    if (!jobTypeKey) next.jobTypeKey = 'Pick a job type.';
    if (customerPending(customer)) next.customerName = customerPendingMessage(customer);
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const res = await api.post<{ jobId: string }>('/api/jobs', {
      companyId,
      jobTypeKey,
      name: name.trim(),
      customerId: customer.id,
      contractCents: mv.contract ? contract : null,
      startDate: start || null,
    });
    setBusy(false);
    if (res.error) {
      const d = res.error.details ?? {};
      setErrors({ ...Object.fromEntries(Object.entries(d).map(([k, m]) => [k, m[0]])), _: res.error.error });
      return;
    }
    toast(`Created ${name.trim()}`);
    router.push(`/jobs/${res.data!.jobId}`);
  };

  return (
    <Panel
      aria-label={`New ${lower(v.job)}`}
      eyebrow={['New', v.job]}
      title={name.trim() || `Untitled ${lower(v.job)}`}
      meta="Number, first stage and status are set for you"
      onClose={onClose}
      foot={
        <div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" chord="mod+enter" bindChord onClick={() => void submit()} disabled={busy} aria-busy={busy || undefined}>
            Create {lower(v.job)}
          </Button>
        </div>
      }
    >
      <PanelSection>
        <form
          className="mp-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {companies.length > 1 && (
            <Field label="Company" error={errors.companyId}>
              <Select
                value={companyId}
                onChange={(e) => {
                  setCompanyId(e.target.value);
                  setJobTypeKey(jobTypes.find((t) => t.location_id === e.target.value)?.key ?? '');
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Job type" error={errors.jobTypeKey} help={types.length === 0 ? 'This company has no job types yet. Finish its setup first.' : undefined}>
            <Select value={jobTypeKey} onChange={(e) => setJobTypeKey(e.target.value)} disabled={types.length === 0}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Name" error={errors.name}>
            <Input data-autofocus autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ankeny clinic remodel" maxLength={120} />
          </Field>
          <Field label={v.customer} error={errors.customerName}>
            <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); if (c.id) setErrors((e) => ({ ...e, customerName: undefined })); }} companyId={companyId} invalid={!!errors.customerName} />
          </Field>
          <div className="mp-form-2">
            {mv.contract && (
              <Field label="Contract value" help="Optional. Sent to Merit Books as the contract." error={errors.contractCents}>
                <MoneyInput valueCents={contract} onChangeCents={setContract} placeholder="0.00" />
              </Field>
            )}
            <Field label="Start date" error={errors.startDate}>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </div>
          {errors._ && <p className="field-error" role="alert">{errors._}</p>}
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
