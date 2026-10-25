'use client';
/**
 * Notification settings (PLT-46): the event × channel matrix with the role default under every
 * cell, the company's required events locked, digest cadence, quiet hours and the person's own
 * work-text number (with consent). Saves through PUT /api/notifications/prefs.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Field, Input, InlineNotice, Select, Switch, Tag, toast, api } from '@meritbooks/merit-ui';
import {
  EVENT_INFO, INTERNAL_EVENTS, effectiveMode, modesFor, recipeFor,
  type ChannelMode, type EventCategory, type InternalEvent, type NotifyChannel,
} from '@/lib/notify/recipes';
import type { NotificationPrefs, PrefRuleRow } from '@/lib/notify/types';
import { clockLabel, inQuietHours, quietEnd as quietEndAt } from '@/lib/notify/quiet-hours';

const CATEGORY_LABEL: Readonly<Record<EventCategory, string>> = {
  work: 'Work assigned to you',
  schedule: 'Schedule',
  time: 'Time',
  approvals: 'Approvals and changes',
  sales: 'Sales and leads',
  documents: 'Documents',
  comments: 'Comments',
};
const CATEGORY_ORDER: readonly EventCategory[] = ['work', 'schedule', 'time', 'approvals', 'sales', 'documents', 'comments'];

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];

const MODE_LABEL: Readonly<Record<ChannelMode, string>> = { instant: 'Right away', digest: 'In my digest', off: 'Off' };

type Draft = Map<string, ChannelMode | null>; // `${event}|${channel}` → override (null = role default)

const keyOf = (e: InternalEvent, c: NotifyChannel) => `${e}|${c}`;

export interface PreferencesFormProps {
  initial: NotificationPrefs;
  roleTitle: string;
}

export function PreferencesForm({ initial, roleTitle }: PreferencesFormProps) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
  const [draft, setDraft] = useState<Draft>(() => new Map(initial.rules.map((r) => [keyOf(r.event_type, r.channel), r.mode])));
  const [digest, setDigest] = useState(initial.digest);
  const [quietOn, setQuietOn] = useState(Boolean(initial.quietStart));
  const [quietStart, setQuietStart] = useState(initial.quietStart?.slice(0, 5) ?? '21:00');
  const [quietEnd, setQuietEnd] = useState(initial.quietEnd?.slice(0, 5) ?? '06:30');
  const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const [tz, setTz] = useState(initial.timezone ?? browserTz ?? 'America/Chicago');
  const [phone, setPhone] = useState(initial.smsPhone ?? '');
  const [consent, setConsent] = useState(initial.smsConsent === 'opted_in');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mandatory = useMemo(() => new Set(prefs.mandatoryEvents), [prefs.mandatoryEvents]);
  const rules: PrefRuleRow[] = useMemo(
    () => [...draft.entries()].flatMap(([k, mode]) => {
      if (mode === null) return [];
      const [event_type, channel] = k.split('|') as [InternalEvent, NotifyChannel];
      return [{ event_type, channel, mode }];
    }),
    [draft],
  );

  const cell = (e: InternalEvent, c: NotifyChannel): ChannelMode =>
    effectiveMode({ event: e, channel: c, persona: prefs.persona, rules, mandatory: mandatory.has(e), muted: prefs.muted, emailOn: prefs.emailOn, digest });

  const setCell = (e: InternalEvent, c: NotifyChannel, mode: ChannelMode) => {
    setDraft((d) => {
      const n = new Map(d);
      n.set(keyOf(e, c), recipeFor(prefs.persona, e)[c] === mode ? null : mode);
      return n;
    });
  };

  const dirtyRules = useMemo(() => {
    const before = new Map(prefs.rules.map((r) => [keyOf(r.event_type, r.channel), r.mode]));
    const keys = new Set([...before.keys(), ...draft.keys()]);
    return [...keys].flatMap((k) => {
      const now = draft.get(k) ?? null;
      const was = before.get(k) ?? null;
      if (now === was) return [];
      const [event_type, channel] = k.split('|') as [InternalEvent, NotifyChannel];
      return [{ event_type, channel, mode: now }];
    });
  }, [draft, prefs.rules]);

  const quietNow = quietOn && inQuietHours(new Date(), { start: quietStart, end: quietEnd }, tz);
  const quietUntil = quietNow ? quietEnd : null;

  const save = async () => {
    setError(null);
    if (phone.trim() && !consent) {
      setError('Tick the box to agree to work texts, or clear the number.');
      return;
    }
    setSaving(true);
    const res = await api.put<NotificationPrefs>('/api/notifications/prefs', {
      rules: dirtyRules,
      digest,
      quietStart: quietOn ? quietStart : null,
      quietEnd: quietOn ? quietEnd : null,
      timezone: tz || null,
      smsPhone: phone.trim() || null,
      smsConsent: Boolean(phone.trim()) && consent,
    });
    setSaving(false);
    if (res.error || !res.data) {
      setError(res.error?.details ? Object.values(res.error.details).flat().join(' ') : res.error?.error ?? 'Your settings were not saved.');
      return;
    }
    setPrefs(res.data);
    setDraft(new Map(res.data.rules.map((r) => [keyOf(r.event_type, r.channel), r.mode])));
    toast('Notification settings saved');
  };

  const resetAll = () => setDraft(new Map([...draft.keys()].map((k) => [k, null])));

  const byCategory = CATEGORY_ORDER.map((cat) => ({ cat, events: INTERNAL_EVENTS.filter((e) => EVENT_INFO[e].category === cat) })).filter((g) => g.events.length);
  const changed = dirtyRules.length > 0 || digest !== prefs.digest || (quietOn ? quietStart : null) !== (prefs.quietStart?.slice(0, 5) ?? null)
    || (quietOn ? quietEnd : null) !== (prefs.quietEnd?.slice(0, 5) ?? null) || (tz || null) !== prefs.timezone || (phone.trim() || null) !== prefs.smsPhone
    || (Boolean(phone.trim()) && consent) !== (prefs.smsConsent === 'opted_in');

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      {error && <InlineNotice tone="neg">{error}</InlineNotice>}
      {prefs.pushDevices === 0 && (
        <InlineNotice tone="info">Push goes to the Merit Workforce phone app. Sign in on your phone to turn it on; until then push choices wait.</InlineNotice>
      )}

      <section aria-labelledby="matrix-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <h2 id="matrix-h" className="t-head">What reaches you <span className="t-cap">{`// defaults for ${roleTitle}`}</span></h2>
          <Button variant="quiet" onClick={resetAll} disabled={rules.length === 0}>Use my role defaults</Button>
        </div>
        <div className="mp-table" style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left', padding: '10px 16px' }}>Event</th>
                <th scope="col" style={{ padding: '10px 12px' }}>Inbox</th>
                <th scope="col" style={{ padding: '10px 12px' }}>Push</th>
                <th scope="col" style={{ padding: '10px 12px' }}>Email</th>
                <th scope="col" style={{ padding: '10px 12px' }}>Text</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map(({ cat, events }) => (
                <FragmentRows key={cat} label={CATEGORY_LABEL[cat]}>
                  {events.map((e) => {
                    const req = mandatory.has(e);
                    const muted = prefs.muted.includes(e) && !req;
                    const def = recipeFor(prefs.persona, e);
                    return (
                      <tr key={e} style={{ borderTop: '1px solid var(--line)' }}>
                        <th scope="row" style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 400 }}>
                          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600 }}>{EVENT_INFO[e].label}</span>
                            {req && <Tag tone="solid">Required</Tag>}
                            {muted && <Tag tone="warn">Muted in Merit Books</Tag>}
                          </span>
                          <span className="t-cap" style={{ display: 'block' }}>{EVENT_INFO[e].description}</span>
                        </th>
                        {(['in_app', 'push'] as const).map((c) => (
                          <td key={c} style={{ textAlign: 'center', padding: '10px 12px' }}>
                            <Switch
                              aria-label={`${EVENT_INFO[e].label}: ${c === 'in_app' ? 'inbox' : 'push'}`}
                              checked={cell(e, c) === 'instant'}
                              disabled={(req && c === 'in_app') || muted || saving}
                              onChange={(ev) => setCell(e, c, ev.currentTarget.checked ? 'instant' : 'off')}
                            />
                            <span className="t-cap" style={{ display: 'block' }}>{`Role: ${def[c] === 'instant' ? 'on' : 'off'}`}</span>
                          </td>
                        ))}
                        <td style={{ textAlign: 'center', padding: '10px 12px' }}>
                          <Select
                            aria-label={`${EVENT_INFO[e].label}: email`}
                            value={cell(e, 'email')}
                            disabled={muted || saving || !prefs.emailOn}
                            onChange={(ev) => setCell(e, 'email', ev.currentTarget.value as ChannelMode)}
                          >
                            {modesFor('email').map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                          </Select>
                          <span className="t-cap" style={{ display: 'block' }}>{`Role: ${MODE_LABEL[def.email].toLowerCase()}`}</span>
                        </td>
                        <td style={{ textAlign: 'center', padding: '10px 12px' }}>
                          <Switch
                            aria-label={`${EVENT_INFO[e].label}: text`}
                            checked={cell(e, 'sms') === 'instant'}
                            disabled={muted || saving || !prefs.smsAvailable || !phone.trim()}
                            onChange={(ev) => setCell(e, 'sms', ev.currentTarget.checked ? 'instant' : 'off')}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </FragmentRows>
              ))}
            </tbody>
          </table>
        </div>
        {!prefs.emailOn && <p className="t-cap" style={{ marginTop: 8 }}>Email is off in your Merit Books notification settings.</p>}
      </section>

      <section aria-labelledby="digest-h" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <h2 id="digest-h" className="t-head">Digest email</h2>
        <Field label="How often" help="Arrives at 8 a.m. your time, never during quiet hours.">
          <Select value={digest} onChange={(e) => setDigest(e.currentTarget.value as NotificationPrefs['digest'])} disabled={saving}>
            <option value="instant">Role default: the items set to digest (daily; weekly for owners)</option>
            <option value="daily">Daily: everything I have not read</option>
            <option value="weekly">Weekly on Monday: everything I have not read</option>
            <option value="off">No digest emails</option>
          </Select>
        </Field>
      </section>

      <section aria-labelledby="quiet-h" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <h2 id="quiet-h" className="t-head">Quiet hours</h2>
        <Switch label="Hold pushes and texts during quiet hours (the inbox still updates)" checked={quietOn} onChange={(e) => setQuietOn(e.currentTarget.checked)} disabled={saving} />
        {quietOn && (
          <div className="mp-form-2">
            <Field label="From"><Input type="time" value={quietStart} onChange={(e) => setQuietStart(e.currentTarget.value)} required /></Field>
            <Field label="Until"><Input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.currentTarget.value)} required /></Field>
          </div>
        )}
        <Field label="Time zone">
          <Select value={tz} onChange={(e) => setTz(e.currentTarget.value)} disabled={saving}>
            {[...new Set([tz, ...ZONES])].filter(Boolean).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        {quietUntil && <p className="t-cap">Quiet now. Pushes and texts wait until {clockLabel(quietUntil)} ({quietEnd && quietEndLabel(quietStart, quietEnd, tz)}).</p>}
      </section>

      <section aria-labelledby="sms-h" style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <h2 id="sms-h" className="t-head">Work texts</h2>
        {!prefs.smsAvailable && <p className="t-cap">Your company has not turned texting on yet. You can still save your number.</p>}
        <Field label="Mobile number" help="Only for your own work notifications. Reply STOP to any text to opt out.">
          <Input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} placeholder="(515) 555-0142" disabled={saving} />
        </Field>
        {prefs.smsConsent === 'opted_out' && <InlineNotice tone="warn">This number replied STOP. Text START to it from your phone to receive texts again.</InlineNotice>}
        <Switch
          label="I agree to receive work texts at this number. Message and data rates may apply."
          checked={consent}
          onChange={(e) => setConsent(e.currentTarget.checked)}
          disabled={saving || !phone.trim()}
        />
      </section>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !changed} chord="mod+s" bindChord>{saving ? 'Saving' : 'Save settings'}</Button>
      </div>
    </div>
  );
}

function quietEndLabel(start: string, end: string, tz: string): string {
  const until = quietEndAt(new Date(), { start, end }, tz);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(until);
}

function FragmentRows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={5} scope="colgroup" className="t-cap" style={{ textAlign: 'left', padding: '14px 16px 6px', textTransform: 'uppercase', letterSpacing: '.12em', background: 'var(--canvas)' }}>
          {label}
        </th>
      </tr>
      {children}
    </>
  );
}
