'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  InlineNotice,
  MoneyInput,
  Seg,
  Select,
  Status,
  Switch,
  api,
  toast,
  useQuery,
} from '@meritbooks/merit-ui';
import { usd } from './receipts-types';
import { QuietHoursNote } from '@/components/requests/quiet-hours-note';
import { formatQuietHours } from '@/lib/requests/quiet-display';
import { quietHoursOf } from '@/lib/requests/cadence';
import type { ActionResult, CardholderOptions, PolicyResponse, ReceiptPolicy } from './receipts-types';
import s from './receipts.module.css';

type Scope = 'tenant' | 'client';
type ClientSwitch = 'follow' | 'on' | 'off';

interface PendingSwitch {
  scope: Scope;
  enabled: boolean;
  follow?: boolean;
  label: string;
}

export function PolicyTab({ locationId, companyName, onChanged }: { locationId: string | null; companyName: string | null; onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const [scope, setScope] = useState<Scope>(locationId ? 'client' : 'tenant');
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const { data, error, isLoading, refetch } = useQuery<PolicyResponse>('/api/receipts/policy', { location_id: locationId ?? undefined }, { key: String(key), scope: false });
  const { data: opts } = useQuery<CardholderOptions>(locationId ? '/api/receipts/cardholders/options' : null, { location_id: locationId ?? undefined }, { scope: false });

  useEffect(() => {
    if (!locationId) setScope('tenant');
  }, [locationId]);

  const reload = () => {
    setKey((k) => k + 1);
    onChanged();
  };

  if (error) {
    return (
      <div className={s.state} role="alert">
        <p className="t-head">Couldn’t load the receipt policy.</p>
        <p className="ink-2">{error}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className={s.state} role="status">
        <p className="t-cap">Loading the receipt policy…</p>
      </div>
    );
  }

  const sw = data.switches;
  const clientValue: ClientSwitch = sw.clientSetting === null ? 'follow' : sw.clientSetting ? 'on' : 'off';
  const editing = scope === 'client' && data.client ? data.client : data.tenant;

  return (
    <div>
      <section className={s.card} aria-labelledby="chase-switch-h">
        <div className={s.cardHead}>
          <div>
            <h2 id="chase-switch-h" className="t-section">
              Receipt chase
            </h2>
            <p className="t-cap">Turn reminders on or off for the whole organization, or for one company. Every change is recorded with your reason.</p>
          </div>
          <Status kind={sw.effective ? 'ready' : 'blocked'}>{sw.effective ? 'On' : 'Off'}{locationId && companyName ? ` for ${companyName}` : ''}</Status>
        </div>
        <div className={s.switchRow}>
          <div>
            <b>Whole organization</b>
            <p className="t-cap">Off stops every reminder for every company. Charges still collect and receipts still match.</p>
          </div>
          <Switch
            label={sw.tenantEnabled ? 'On' : 'Off'}
            checked={sw.tenantEnabled}
            onChange={(e) => setPending({ scope: 'tenant', enabled: e.target.checked, label: e.target.checked ? 'Turn receipt chase on for the organization' : 'Turn receipt chase off for the organization' })}
          />
        </div>
        {locationId && (
          <div className={s.switchRow}>
            <div>
              <b>{companyName ?? 'This company'}</b>
              <p className="t-cap">For a client whose own office collects receipts. Can only be on while the organization is on.</p>
            </div>
            <Seg<ClientSwitch>
              aria-label="Receipt chase for this company"
              value={clientValue}
              onChange={(v) =>
                setPending({
                  scope: 'client',
                  enabled: v !== 'off',
                  follow: v === 'follow',
                  label: v === 'follow' ? `Make ${companyName ?? 'this company'} follow the organization` : v === 'on' ? `Turn chase on for ${companyName ?? 'this company'}` : `Turn chase off for ${companyName ?? 'this company'}`,
                })
              }
              items={[
                { value: 'follow', label: 'Follow organization' },
                { value: 'on', label: 'On', disabled: !sw.tenantEnabled },
                { value: 'off', label: 'Off' },
              ]}
            />
          </div>
        )}
        <p className="t-cap" style={{ marginTop: 12 }}>
          First reminder {data.cadence.firstReminderMinutes} min after the charge appears (change under{' '}
          <a className="link" href="/settings?tab=chase">
            Settings → Receipt chase
          </a>
          ).{' '}
          {data.quietHours ? (
            <QuietHoursNote summary={data.quietHours} primary="receipt" />
          ) : (
            <>Quiet hours {formatQuietHours(quietHoursOf(data.cadence.quietStart, data.cadence.quietEnd))} in the cardholder’s time zone.</>
          )}{' '}
          Reminders go by email (and in-app for team members); text and push start when they are set up.
        </p>
      </section>

      <section className={s.card} aria-labelledby="policy-h">
        <div className={s.cardHead}>
          <div>
            <h2 id="policy-h" className="t-section">
              Receipt policy
            </h2>
            <p className="t-cap">When a receipt is needed, how long people have, who hears when it’s late, and how strictly receipts match charges.</p>
          </div>
          {locationId && (
            <Seg<Scope>
              aria-label="Which policy"
              value={scope}
              onChange={setScope}
              items={[
                { value: 'tenant', label: 'Organization default' },
                { value: 'client', label: companyName ?? 'This company' },
              ]}
            />
          )}
        </div>
        {scope === 'client' && !data.clientOverrides && (
          <InlineNotice title={`${companyName ?? 'This company'} follows the organization default.`}>Change anything below to give it its own policy.</InlineNotice>
        )}
        <PolicyForm
          key={`${scope}:${key}`}
          policy={editing}
          scope={scope}
          locationId={scope === 'client' ? locationId : null}
          hasOverride={!!data.clientOverrides}
          members={opts?.members ?? []}
          onSaved={reload}
        />
      </section>

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        tone={pending && !pending.enabled ? 'danger' : 'primary'}
        title={pending?.label ?? ''}
        confirmLabel={pending?.enabled ? 'Turn on' : 'Turn off'}
        reason={{ label: 'Why?', help: 'Recorded in the audit trail with your name.', minLength: 3 }}
        onConfirm={async (reason) => {
          if (!pending) return;
          const res = await api.post<ActionResult>('/api/receipts/policy/switch', {
            scope: pending.scope,
            location_id: pending.scope === 'client' ? locationId : undefined,
            enabled: pending.enabled,
            follow: pending.follow,
            reason: reason ?? '',
          });
          if (res.error) {
            toast.error(res.error.error);
            return;
          }
          toast(res.data?.message ?? 'Saved.');
          setPending(null);
          reload();
        }}
      >
        <p className="ink-2">
          {pending?.enabled
            ? 'Only charges still inside the chase window are asked about — nobody gets a burst of old reminders.'
            : 'Open reminders stop now. Nothing is deleted; the charges stay on the board as “Chase off”.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}

interface PolicyFormProps {
  policy: ReceiptPolicy;
  scope: Scope;
  locationId: string | null;
  hasOverride: boolean;
  members: CardholderOptions['members'];
  onSaved: () => void;
}

function PolicyForm({ policy, scope, locationId, hasOverride, members, onSaved }: PolicyFormProps) {
  const [p, setP] = useState<ReceiptPolicy>(policy);
  const [days, setDays] = useState(policy.reminderDays.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ReceiptPolicy>(k: K, v: ReceiptPolicy[K]) => setP((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setErr(null);
    const parsed = days
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((d) => Number(d));
    if (parsed.length === 0 || parsed.some((d) => !Number.isInteger(d) || d < 0 || d > 90)) return setErr('Reminder days are whole days from 0 to 90, separated by commas (e.g. 0, 2, 5, 10).');
    setBusy(true);
    const patch: Partial<ReceiptPolicy> = { ...p, reminderDays: Array.from(new Set(parsed)).sort((a, b) => a - b) };
    const res = await api.put<ActionResult>('/api/receipts/policy', { location_id: scope === 'client' ? locationId : null, patch });
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(res.data?.message ?? 'Saved.');
    onSaved();
  };
  const reset = async () => {
    const res = await api.put<ActionResult>('/api/receipts/policy', { location_id: locationId, reset: true, patch: {} });
    if (res.error) return toast.error(res.error.error);
    toast(res.data?.message ?? 'Reset.');
    onSaved();
  };

  return (
    <div className={s.formGrid}>
      {err && (
        <InlineNotice tone="neg" title="Check this.">
          {err}
        </InlineNotice>
      )}
      <div className={s.three}>
        <Field label="Receipt needed over" help="Charges at or under this need no receipt (the IRS line is 75.00).">
          <MoneyInput valueCents={p.receiptRequiredOverCents} onChangeCents={(c) => set('receiptRequiredOverCents', Math.max(0, c ?? 0))} />
        </Field>
        <Field label="Grace days" help="Wait this long before the first reminder (e-receipts often arrive on their own).">
          <Input type="number" min={0} max={30} value={p.graceDays} onChange={(e) => set('graceDays', Number(e.target.value))} />
        </Field>
        <Field label="Chase window (days)" help="Charges older than this are never chased.">
          <Input type="number" min={1} max={365} value={p.chaseWindowDays} onChange={(e) => set('chaseWindowDays', Number(e.target.value))} />
        </Field>
      </div>
      <div className={s.three}>
        <Field label="Reminder days" help="Day 0 = the first reminder time from Settings.">
          <Input value={days} onChange={(e) => setDays(e.target.value)} placeholder="0, 2, 5, 10" />
        </Field>
        <Field label="After the last reminder, tell">
          <Select value={p.escalateTo} onChange={(e) => set('escalateTo', e.target.value as ReceiptPolicy['escalateTo'])}>
            <option value="manager">The cardholder’s manager</option>
            <option value="bookkeeper">The bookkeeper</option>
            <option value="none">Nobody</option>
          </Select>
        </Field>
        <Field label="Bookkeeper" help="Owns the chase, gets the Monday digest.">
          <Select value={p.bookkeeperMembershipId ?? ''} onChange={(e) => set('bookkeeperMembershipId', e.target.value || null)}>
            <option value="">Tenant admins</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className={s.three}>
        <Field label="Note required">
          <Switch label={p.memoRequired ? `Over ${usd(p.memoRequiredOverCents)}` : 'Not required'} checked={p.memoRequired} onChange={(e) => set('memoRequired', e.target.checked)} />
        </Field>
        <Field label="Note required over">
          <MoneyInput valueCents={p.memoRequiredOverCents} disabled={!p.memoRequired} onChangeCents={(c) => set('memoRequiredOverCents', Math.max(0, c ?? 0))} />
        </Field>
        <Field label="Monday digest">
          <Switch label={p.digestEnabled ? 'On' : 'Off'} checked={p.digestEnabled} onChange={(e) => set('digestEnabled', e.target.checked)} />
        </Field>
      </div>
      <div className={s.three}>
        <Field label="Amount tolerance" help="Receipt and charge may differ by this much.">
          <MoneyInput valueCents={p.amountToleranceCents} onChangeCents={(c) => set('amountToleranceCents', Math.max(0, c ?? 0))} />
        </Field>
        <Field label="Tip allowance (%)" help="A charge higher than the receipt by up to this share still matches (needs a click).">
          <Input type="number" min={0} max={100} value={Math.round(p.tipToleranceBp / 100)} onChange={(e) => set('tipToleranceBp', Math.round(Number(e.target.value) * 100))} />
        </Field>
        <Field label="Date window (days)">
          <Input type="number" min={0} max={14} value={p.dateWindowDays} onChange={(e) => set('dateWindowDays', Number(e.target.value))} />
        </Field>
      </div>
      <div className={s.two}>
        <Field label="Auto-match at (score)" help="Clear winners at or above this match with no click.">
          <Input type="number" min={50} max={100} value={Math.round(p.autoMatchMinScore * 100)} onChange={(e) => set('autoMatchMinScore', Number(e.target.value) / 100)} />
        </Field>
        <Field label="Suggest at (score)" help="Between this and auto-match, a person confirms with one click.">
          <Input type="number" min={30} max={100} value={Math.round(p.suggestMinScore * 100)} onChange={(e) => set('suggestMinScore', Number(e.target.value) / 100)} />
        </Field>
      </div>
      <div className={s.actions}>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : scope === 'client' ? 'Save for this company' : 'Save organization default'}
        </Button>
        {scope === 'client' && hasOverride && <Button onClick={() => void reset()}>Follow the organization again</Button>}
      </div>
    </div>
  );
}
