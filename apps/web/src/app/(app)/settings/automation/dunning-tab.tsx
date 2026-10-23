'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Eyebrow,
  Field,
  InlineNotice,
  Input,
  MoneyInput,
  Seg,
  Select,
  Switch,
  Textarea,
  api,
  toast,
} from '@meritbooks/merit-ui';
import {
  DEFAULT_DUNNING_STEPS,
  DUNNING_STEP_STAGES,
  STAGE_LABEL,
  TEMPLATE_TOKENS,
  type DunningPolicy,
  type DunningStep,
  type DunningStepStage,
} from '@/lib/collections/dunning-policy';
import type { PoliciesResponse } from './automation-types';
import { CustomerPicker, ScopePicker } from './policy-scope';
import s from './automation.module.css';

interface ApiErr {
  error: string;
  details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
}

function whenLabel(days: number): string {
  if (days === 0) return 'On the due date';
  return days < 0 ? `${-days} day${days === -1 ? '' : 's'} before due` : `${days} day${days === 1 ? '' : 's'} after due`;
}

/**
 * Dunning ladder editor (migration 184 dunning_policies). Tenant default + per-company
 * overrides. The ladder only sends on its own when BOTH this policy says "Send" and the
 * tenant's "Scheduled payment reminders" autonomy dial allows it.
 */
export function DunningTab({ data, onSaved }: { data: PoliciesResponse; onSaved: () => void }) {
  const [scope, setScope] = useState<string | null>(null);
  const overrides = useMemo(() => new Set(data.dunning.companies.map((c) => c.locationId)), [data]);
  const source = useMemo<DunningPolicy>(() => {
    if (scope) return data.dunning.companies.find((c) => c.locationId === scope)?.policy ?? data.dunning.tenant;
    return data.dunning.tenant;
  }, [scope, data]);

  const [p, setP] = useState<DunningPolicy>(source);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setP({ ...source, steps: [...source.steps].sort((a, b) => a.days - b.days) });
    setErrors([]);
  }, [source]);

  const set = <K extends keyof DunningPolicy>(k: K, v: DunningPolicy[K]) => setP((x) => ({ ...x, [k]: v }));
  const setStep = (i: number, patch: Partial<DunningStep>) => setP((x) => ({ ...x, steps: x.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));
  const unusedStage = (): DunningStepStage | null => DUNNING_STEP_STAGES.find((st) => !p.steps.some((x) => x.stage === st)) ?? null;

  async function save() {
    setSaving(true);
    setErrors([]);
    const res = await api.put<{ ok: boolean }>('/api/automation/policies', {
      kind: 'dunning',
      policy: {
        location_id: scope,
        enabled: p.enabled,
        send_mode: p.sendMode,
        steps: p.steps.map((st) => ({ stage: st.stage, days: Math.trunc(Number(st.days) || 0), subject: st.subject, body: st.body })),
        stop_on_promise: p.stopOnPromise,
        stop_on_dispute: p.stopOnDispute,
        excluded_customer_ids: p.excludedCustomerIds,
        min_balance_cents: p.minBalanceCents,
      },
    });
    setSaving(false);
    if (res.error) {
      const e = res.error as unknown as ApiErr;
      const msgs = [...(e.details?.formErrors ?? []), ...Object.values(e.details?.fieldErrors ?? {}).flat()];
      setErrors(msgs.length ? msgs : [e.error]);
      toast.error(e.error);
      return;
    }
    toast(p.enabled ? 'Dunning ladder saved — it runs tomorrow morning.' : 'Saved. The ladder is off.');
    onSaved();
  }

  return (
    <div className={s.form}>
      <InlineNotice tone="info" title="How reminders go out">
        Each morning the ladder prepares the next reminder for every open invoice. In <b>Draft</b> mode each one waits in
        Requests → Payment reminders for someone to read and press Send now. In <b>Send</b> mode it goes out by itself — but only
        when Settings → Autonomy → “Scheduled payment reminders” is set to auto-send and the invoice is under that limit.
        Quiet hours, unsubscribes and send limits always apply. It stops by itself when the invoice is paid.
      </InlineNotice>

      <div className={s.section}>
        <div className={s.row2}>
          <ScopePicker companies={data.companies} overrides={overrides} value={scope} onChange={setScope} />
          <Field label="Payment reminders">
            <Switch label={p.enabled ? 'On' : 'Off'} checked={p.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          </Field>
        </div>
        <div className={s.row2} style={{ marginTop: 16 }}>
          <Field label="When a reminder is ready" help={p.sendMode === 'AUTO' ? 'Sends by itself within your autonomy limit; otherwise waits for you.' : 'Always waits for someone to send it.'}>
            <Seg<'DRAFT' | 'AUTO'>
              aria-label="Draft or send"
              value={p.sendMode}
              onChange={(v) => set('sendMode', v)}
              items={[
                { value: 'DRAFT', label: 'Draft for review' },
                { value: 'AUTO', label: 'Send automatically' },
              ]}
            />
          </Field>
          <Field label="Don’t remind under" help="Invoices with a smaller balance are left alone.">
            <MoneyInput valueCents={p.minBalanceCents} onChangeCents={(c) => set('minBalanceCents', Math.max(0, c ?? 0))} />
          </Field>
        </div>
      </div>

      <div className={s.section}>
        <Eyebrow>{['02', 'The ladder']}</Eyebrow>
        <p className="t-cap">
          Leave a subject or message blank to use the built-in wording for that step. You can use{' '}
          {TEMPLATE_TOKENS.map((t, i) => (
            <span key={t}>
              <code>{`{{${t}}}`}</code>
              {i < TEMPLATE_TOKENS.length - 1 ? ', ' : ''}
            </span>
          ))}
          .
        </p>
        <div className={s.steps}>
          {p.steps.map((st, i) => (
            <div className={s.step} key={`${st.stage}-${i}`}>
              <Field label="Step">
                <Select value={st.stage} onChange={(e) => setStep(i, { stage: e.target.value as DunningStepStage })}>
                  {DUNNING_STEP_STAGES.map((stage) => (
                    <option key={stage} value={stage} disabled={stage !== st.stage && p.steps.some((x) => x.stage === stage)}>
                      {STAGE_LABEL[stage]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Days from due" help={whenLabel(Number(st.days) || 0)}>
                <Input type="number" min={-60} max={365} value={String(st.days)} onChange={(e) => setStep(i, { days: Math.trunc(Number(e.target.value) || 0) })} />
              </Field>
              <div className={s.stepText}>
                <Field label="Subject">
                  <Input value={st.subject} maxLength={200} placeholder="Built-in subject" onChange={(e) => setStep(i, { subject: e.target.value })} />
                </Field>
                <Field label="Message">
                  <Textarea rows={3} value={st.body} maxLength={4000} placeholder="Built-in message (amount, due date, pay link filled in for you)" onChange={(e) => setStep(i, { body: e.target.value })} />
                </Field>
              </div>
              <Button variant="quiet" icon="x" aria-label={`Remove ${STAGE_LABEL[st.stage]}`} disabled={p.steps.length <= 1} onClick={() => setP((x) => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div className={s.actions} style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          <Button
            icon="plus"
            disabled={p.steps.length >= 8 || !unusedStage()}
            onClick={() => {
              const stage = unusedStage();
              if (!stage) return;
              const last = p.steps.reduce((m, x) => Math.max(m, x.days), -3);
              setP((x) => ({ ...x, steps: [...x.steps, { stage, days: Math.min(365, last + 30), subject: '', body: '' }] }));
            }}
          >
            Add a step
          </Button>
          <Button variant="quiet" onClick={() => set('steps', [...DEFAULT_DUNNING_STEPS])}>
            Reset to the standard ladder
          </Button>
        </div>
      </div>

      <div className={s.section}>
        <Eyebrow>{['03', 'When to stop']}</Eyebrow>
        <div className={s.row2} style={{ marginTop: 8 }}>
          <Switch label="Hold while the customer has promised to pay (until the promise date passes)" checked={p.stopOnPromise} onChange={(e) => set('stopOnPromise', e.target.checked)} />
          <Switch label="Hold while the invoice is disputed" checked={p.stopOnDispute} onChange={(e) => set('stopOnDispute', e.target.checked)} />
        </div>
        <div style={{ marginTop: 16 }}>
          <CustomerPicker
            label="Never remind these customers"
            help="Key accounts you handle personally."
            customers={data.customers}
            selected={p.excludedCustomerIds}
            onChange={(ids) => set('excludedCustomerIds', ids)}
          />
        </div>
      </div>

      {errors.length > 0 && (
        <InlineNotice tone="neg" title="Not saved">
          {errors.join(' ')}
        </InlineNotice>
      )}
      <div className={s.actions}>
        {scope && overrides.has(scope) && (
          <Button variant="quiet" onClick={() => setConfirmRemove(true)}>
            Use the default instead
          </Button>
        )}
        <Button variant="primary" icon="check" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : scope ? 'Save for this company' : 'Save the default'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Drop this company’s own ladder?"
        confirmLabel="Use the default"
        tone="danger"
        onConfirm={async () => {
          setConfirmRemove(false);
          const res = await api.put<{ ok: boolean }>('/api/automation/policies', { kind: 'remove_company', policy_kind: 'dunning', location_id: scope });
          if (res.error) toast.error(res.error.error);
          else {
            toast('This company now uses the default ladder.');
            onSaved();
          }
        }}
      >
        Reminders already prepared stay where they are; from tomorrow this company follows the default ladder.
      </ConfirmDialog>
    </div>
  );
}
