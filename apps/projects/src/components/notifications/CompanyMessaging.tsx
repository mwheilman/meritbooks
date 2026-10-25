'use client';
/**
 * Company messages (settings holders): per company the customer go-live switch (customer
 * messages are HELD until it flips), texting (number + on/off), frequency caps, the speed-to-lead
 * window and required events; then the held queue — review, release (only once live) or discard.
 */
import { useMemo, useState } from 'react';
import { Button, Check, ConfirmDialog, Field, InlineNotice, Input, Status, Switch, Tag, toast, api } from '@meritbooks/merit-ui';
import { EVENT_INFO, INTERNAL_EVENTS, type InternalEvent } from '@/lib/notify/recipes';
import type { CompanyNotifySettings, HeldMessage } from '@/lib/notify/types';
import { ago } from '@/lib/notify/format';

export interface CompanyMessagingProps {
  settings: CompanyNotifySettings[];
  held: HeldMessage[];
  companyNames: Readonly<Record<string, string>>;
  providers: { email: boolean; sms: boolean; push: boolean };
}

type Patch = Partial<{
  customer_messages_live: boolean; sms_enabled: boolean; mandatory_events: string[];
  push_per_hour: number; sms_per_day: number; email_per_hour: number; customer_sms_per_day: number; lead_sla_minutes: number;
}>;

function CompanyCard({ s, name, providers, onSaved }: { s: CompanyNotifySettings; name: string; providers: CompanyMessagingProps['providers']; onSaved: (n: CompanyNotifySettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'live' | 'hold' | null>(null);
  const [from, setFrom] = useState(s.smsFromNumber ?? '');
  const [caps, setCaps] = useState({ push: s.pushPerHour, sms: s.smsPerDay, email: s.emailPerHour, customer: s.customerSmsPerDay, sla: s.leadSlaMinutes });
  const [required, setRequired] = useState<Set<string>>(new Set(s.mandatoryEvents));
  const [error, setError] = useState<string | null>(null);
  const [sender, setSender] = useState<{ status: string; reason: string | null } | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ phone: string; status: 'verified' | 'pending' | 'refused'; reason: string | null }>('/api/notifications/settings/sender', { companyId: s.companyId, phone: from.trim() });
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.error ?? 'The number was not saved.');
      return;
    }
    setSender({ status: res.data.status, reason: res.data.reason });
    if (res.data.status === 'verified') {
      onSaved({ ...s, smsFromNumber: res.data.phone });
      toast('Texting number verified');
    }
  };

  const save = async (patch: Patch, okText: string) => {
    setBusy(true);
    setError(null);
    const res = await api.put<CompanyNotifySettings>('/api/notifications/settings', { companyId: s.companyId, patch });
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error?.details ? Object.values(res.error.details).flat().join(' ') : res.error?.error ?? 'Not saved.');
      return false;
    }
    onSaved(res.data);
    toast(okText);
    return true;
  };

  const dirtyCaps = caps.push !== s.pushPerHour || caps.sms !== s.smsPerDay || caps.email !== s.emailPerHour || caps.customer !== s.customerSmsPerDay || caps.sla !== s.leadSlaMinutes;
  const dirtyRequired = [...required].sort().join() !== [...s.mandatoryEvents].sort().join();
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

  return (
    <section className="mp-table" aria-labelledby={`co-${s.companyId}`} style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 id={`co-${s.companyId}`} className="t-head">{name}</h2>
        {s.customerMessagesLive ? <Status kind="ready">Live for customers</Status> : <Status kind="blocked">Customer messages held</Status>}
      </div>
      {error && <InlineNotice tone="neg">{error}</InlineNotice>}

      <div style={{ display: 'grid', gap: 8 }}>
        <span className="t-cap">
          {s.customerMessagesLive
            ? `Live since ${s.liveAt ? new Date(s.liveAt).toLocaleString() : 'go-live'}. On-my-way, reminders and signing requests go to customers.`
            : 'Until this company goes live, every customer email and text is held here. Staff notifications work now.'}
        </span>
        <div>
          {s.customerMessagesLive
            ? <Button variant="danger" disabled={busy} onClick={() => setConfirm('hold')}>Hold customer messages</Button>
            : <Button variant="primary" disabled={busy} onClick={() => setConfirm('live')}>Go live for customers</Button>}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <span className="t-head">Texting</span>
        {!providers.sms && <InlineNotice tone="info">Texting is not connected yet (Twilio account and 10DLC registration). Settings save now and start working once it is.</InlineNotice>}
        <div className="mp-form-2">
          <Field label="Company texting number" help="The number Merit provisioned for this company in Twilio. It is checked with Twilio before it can send.">
            <Input type="tel" value={from} onChange={(e) => setFrom(e.currentTarget.value)} disabled={busy} />
          </Field>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Button disabled={busy || !from.trim() || from.trim() === s.smsFromNumber} onClick={() => void verify()}>Verify number</Button>
          </div>
        </div>
        {s.smsFromNumber && <span className="t-cap">Verified: {s.smsFromNumber}</span>}
        {sender && sender.status !== 'verified' && (
          <InlineNotice tone={sender.status === 'refused' ? 'neg' : 'info'}>
            {sender.status === 'pending' ? `Waiting for verification. ${sender.reason ?? ''}` : sender.reason ?? 'That number cannot be used.'}
          </InlineNotice>
        )}
        <Switch
          label="Send texts from this company (needs the customer's consent; STOP is honored everywhere)"
          checked={s.smsEnabled}
          disabled={busy || (!s.smsFromNumber && !s.smsEnabled)}
          onChange={(e) => void save({ sms_enabled: e.currentTarget.checked }, e.currentTarget.checked ? 'Texting on' : 'Texting off')}
        />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <span className="t-head">Limits</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Field label="Pushes per person per hour"><Input type="number" min={1} max={120} value={caps.push} onChange={(e) => setCaps({ ...caps, push: num(e.currentTarget.value, 1, 120) })} /></Field>
          <Field label="Work texts per person per day"><Input type="number" min={1} max={50} value={caps.sms} onChange={(e) => setCaps({ ...caps, sms: num(e.currentTarget.value, 1, 50) })} /></Field>
          <Field label="Emails per person per hour"><Input type="number" min={1} max={200} value={caps.email} onChange={(e) => setCaps({ ...caps, email: num(e.currentTarget.value, 1, 200) })} /></Field>
          <Field label="Texts per customer per day"><Input type="number" min={1} max={20} value={caps.customer} onChange={(e) => setCaps({ ...caps, customer: num(e.currentTarget.value, 1, 20) })} /></Field>
          <Field label="Speed to lead (minutes)" help="A lead with no call, text or email by then alerts its owner and the sales managers."><Input type="number" min={5} max={10080} value={caps.sla} onChange={(e) => setCaps({ ...caps, sla: num(e.currentTarget.value, 5, 10080) })} /></Field>
        </div>
        <div>
          <Button disabled={busy || !dirtyCaps} onClick={() => void save({ push_per_hour: caps.push, sms_per_day: caps.sms, email_per_hour: caps.email, customer_sms_per_day: caps.customer, lead_sla_minutes: caps.sla }, 'Limits saved')}>Save limits</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <span className="t-head">Required notifications <span className="t-cap">// nobody can turn the inbox copy off</span></span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 4 }}>
          {INTERNAL_EVENTS.map((e: InternalEvent) => (
            <Check
              key={e}
              label={<>{EVENT_INFO[e].label}{EVENT_INFO[e].mandatory ? <> <Tag>Always</Tag></> : null}</>}
              checked={EVENT_INFO[e].mandatory || required.has(e)}
              disabled={busy || EVENT_INFO[e].mandatory}
              onChange={(ev) => setRequired((r) => { const n = new Set(r); if (ev.currentTarget.checked) n.add(e); else n.delete(e); return n; })}
            />
          ))}
        </div>
        <div><Button disabled={busy || !dirtyRequired} onClick={() => void save({ mandatory_events: [...required] }, 'Required notifications saved')}>Save required</Button></div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'live' ? `Go live for customers at ${name}?` : `Hold customer messages at ${name}?`}
        confirmLabel={confirm === 'live' ? 'Go live' : 'Hold messages'}
        tone={confirm === 'live' ? 'primary' : 'danger'}
        onConfirm={async () => {
          const ok = await save({ customer_messages_live: confirm === 'live' }, confirm === 'live' ? `${name} is live for customers` : `Customer messages held at ${name}`);
          if (ok) setConfirm(null);
        }}
      >
        {confirm === 'live'
          ? 'New on-my-way texts, reminders and signing requests will reach customers. Messages already held stay held until you release them below.'
          : 'New customer messages will wait here until you go live again. Staff notifications are not affected.'}
      </ConfirmDialog>
    </section>
  );
}

export function CompanyMessaging({ settings: initialSettings, held: initialHeld, companyNames, providers }: CompanyMessagingProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [held, setHeld] = useState(initialHeld);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const live = useMemo(() => new Set(settings.filter((s) => s.customerMessagesLive).map((s) => s.companyId)), [settings]);

  const act = async (action: 'release' | 'discard') => {
    const ids = [...selected];
    setBusy(true);
    const res = await api.post<{ updated: number }>('/api/notifications/held', { ids, action });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    setHeld((h) => h.filter((m) => !ids.includes(m.id)));
    setSelected(new Set());
    toast(`${res.data?.updated ?? 0} ${action === 'release' ? 'released' : 'discarded'}`);
  };

  const canRelease = selected.size > 0 && [...selected].every((id) => {
    const m = held.find((x) => x.id === id);
    return m?.companyId ? live.has(m.companyId) : false;
  });

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <p className="t-cap">
        Providers: email {providers.email ? 'connected' : 'not connected'} · texting {providers.sms ? 'connected' : 'not connected'} · push {providers.push ? 'connected' : 'not connected'}.
      </p>
      {settings.map((s) => (
        <CompanyCard key={s.companyId} s={s} name={companyNames[s.companyId] ?? 'Company'} providers={providers}
          onSaved={(n) => setSettings((all) => all.map((x) => (x.companyId === n.companyId ? n : x)))} />
      ))}

      <section aria-labelledby="held-h" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 id="held-h" className="t-head">Held customer messages <span className="t-cap">// {held.length}</span></h2>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" disabled={busy || !canRelease} onClick={() => void act('release')}>Release {selected.size || ''}</Button>
            <Button variant="danger" disabled={busy || selected.size === 0} onClick={() => setDiscard(true)}>Discard</Button>
          </span>
        </div>
        <div className="mp-table">
          {held.length === 0 ? (
            <p style={{ padding: 16 }} className="t-cap">Nothing is waiting. Messages to customers sent before go-live show here.</p>
          ) : (
            <ul style={{ margin: 0, padding: 0 }}>
              {held.map((m) => (
                <li key={m.id} style={{ listStyle: 'none', display: 'flex', gap: 12, padding: '10px 16px', borderTop: '1px solid var(--line)', alignItems: 'flex-start' }}>
                  <Check
                    aria-label={`Select the message to ${m.toAddress}`}
                    checked={selected.has(m.id)}
                    onChange={(e) => setSelected((sel) => { const n = new Set(sel); if (e.currentTarget.checked) n.add(m.id); else n.delete(m.id); return n; })}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 600 }}>{m.subject ?? (m.channel === 'sms' ? 'Text' : 'Email')}</span>
                      <Tag>{m.channel === 'sms' ? 'Text' : 'Email'}</Tag>
                      <span className="t-cap">to {m.toAddress} · {m.companyId ? companyNames[m.companyId] ?? '' : ''}</span>
                    </span>
                    <span className="t-cap" style={{ display: 'block', color: 'var(--ink-2)' }}>{m.body ?? 'Message text hidden: it needs contract-value access at this company.'}</span>
                    {m.statusReason && <span className="t-cap" style={{ display: 'block' }}>{m.statusReason}</span>}
                  </span>
                  <span className="t-cap" style={{ flex: 'none' }}>{ago(m.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={discard}
        onClose={() => setDiscard(false)}
        title={`Discard ${selected.size} held message${selected.size === 1 ? '' : 's'}?`}
        confirmLabel="Discard messages"
        tone="danger"
        onConfirm={async () => { await act('discard'); setDiscard(false); }}
      >
        They will never be sent. The record stays in the message log.
      </ConfirmDialog>
    </div>
  );
}
