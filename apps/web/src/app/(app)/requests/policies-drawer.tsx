'use client';

import { useEffect, useState } from 'react';
import { Button, Drawer, Field, InlineNotice, Input, PanelSection, Switch, Tag, api, toast, useQuery } from '@meritbooks/merit-ui';
import { describeCadence, parseDayList } from '@/lib/requests/cadence';
import type { PoliciesResponse, PolicyView } from './requests-types';
import s from './requests.module.css';

const DAY = 1440;

interface Draft {
  days: string;
  repeatDays: string;
  max: string;
  escalate: string;
  autoCreate: boolean;
}

function toDraft(p: PolicyView): Draft {
  return {
    days: p.offsetsMinutes.map((m) => String(Math.round(m / DAY))).join(', '),
    repeatDays: p.repeatEveryMinutes ? String(Math.round(p.repeatEveryMinutes / DAY)) : '',
    max: String(p.maxSends),
    escalate: p.escalateAfter ? String(p.escalateAfter) : '',
    autoCreate: p.autoCreate,
  };
}

function intOrNull(v: string, min: number, max: number): number | null | 'bad' {
  if (!v.trim()) return null;
  if (!/^\d+$/.test(v.trim())) return 'bad';
  const n = Number(v);
  return n < min || n > max ? 'bad' : n;
}

/**
 * Requests → "Cadence & quiet hours": tenant defaults per kind (copied onto each new
 * request), the tenant quiet hours + time zone, and the automatic W-9 / COI switch.
 * Receipt chase shows read-only — it is edited in Settings → Receipt chase.
 */
export function PoliciesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [key, setKey] = useState(0);
  const { data, error, isLoading } = useQuery<PoliciesResponse>(open ? '/api/requests/policies' : null, undefined, { key: String(key), scope: false });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [quiet, setQuiet] = useState({ start: '20:00', end: '07:00', tz: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDrafts(Object.fromEntries(data.policies.filter((p) => p.source !== 'receipt_settings').map((p) => [p.key, toDraft(p)])));
    setQuiet({ start: data.tenant.quiet.start, end: data.tenant.quiet.end, tz: data.tenant.timezone });
    setErrs({});
  }, [data]);

  const editable = !!data?.canEdit;

  async function save() {
    if (!data) return;
    const e: Record<string, string> = {};
    const policies: Record<string, unknown>[] = [{ policy_key: 'default', quiet_start: quiet.start || null, quiet_end: quiet.end || null, timezone: quiet.tz || null }];
    if ((quiet.start === '') !== (quiet.end === '')) e.quiet = 'Give both a start and an end (or clear both).';
    for (const p of data.policies) {
      if (p.source === 'receipt_settings') continue;
      const d = drafts[p.key];
      if (!d) continue;
      const offsets = parseDayList(d.days);
      if (!offsets) e[`${p.key}.days`] = 'Days like “0, 3, 7”.';
      else if (p.anchor === 'created' && offsets.some((m) => m < 0)) e[`${p.key}.days`] = 'Days after the ask can’t be negative.';
      const repeat = intOrNull(d.repeatDays, 1, 365);
      const max = intOrNull(d.max, 1, 100);
      const esc = intOrNull(d.escalate, 1, 100);
      if (repeat === 'bad') e[`${p.key}.repeat`] = '1–365';
      if (max === 'bad' || max === null) e[`${p.key}.max`] = '1–100';
      if (esc === 'bad') e[`${p.key}.esc`] = '1–100';
      if (offsets && repeat !== 'bad' && max !== 'bad' && max !== null && esc !== 'bad') {
        policies.push({
          policy_key: p.key,
          cadence_offsets_minutes: offsets,
          repeat_every_minutes: repeat === null ? null : repeat * DAY,
          max_sends: max,
          escalate_after: esc,
          ...(p.supportsAutoCreate ? { auto_create: d.autoCreate } : {}),
        });
      }
    }
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await api.put<{ ok: boolean }>('/api/requests/policies', { policies });
    setBusy(false);
    if (res.error) {
      setErrs({ form: res.error.error });
      return;
    }
    toast('Saved. New requests use these settings; open ones keep the schedule they started with.');
    setKey((k) => k + 1);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      eyebrow={['Requests', 'Settings']}
      title="Cadence & quiet hours"
      meta="Defaults for new requests. Each request keeps the schedule it started with."
      foot={
        editable ? (
          <div className={s.actions}>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {error ? (
        <PanelSection>
          <InlineNotice tone="neg" title="Couldn’t load the settings.">
            {error}
          </InlineNotice>
        </PanelSection>
      ) : isLoading || !data ? (
        <PanelSection>
          <p className="t-cap" role="status">
            Loading…
          </p>
        </PanelSection>
      ) : (
        <>
          {!editable && (
            <PanelSection>
              <InlineNotice title="Read-only.">Only a tenant admin (Settings — system: edit) can change these.</InlineNotice>
            </PanelSection>
          )}
          {!data.email.configured && (
            <PanelSection>
              <InlineNotice tone="warn" title="Email isn’t set up.">
                {data.email.reason}
              </InlineNotice>
            </PanelSection>
          )}
          {errs.form && (
            <PanelSection>
              <InlineNotice tone="neg" title="Couldn’t save.">
                {errs.form}
              </InlineNotice>
            </PanelSection>
          )}
          <PanelSection title="Quiet hours" meta={<span className="t-cap">recipient’s local time</span>}>
            <div className={s.twoCol}>
              <Field label="Don’t send after" error={errs.quiet}>
                <Input type="time" value={quiet.start} disabled={!editable} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} />
              </Field>
              <Field label="Until">
                <Input type="time" value={quiet.end} disabled={!editable} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
              </Field>
            </div>
            <Field label="Time zone when the recipient’s isn’t known" help={`Your organization is on ${data.tenant.orgTimezone ?? 'UTC'}.`}>
              <Input value={quiet.tz} disabled={!editable} onChange={(e) => setQuiet({ ...quiet, tz: e.target.value })} placeholder="America/Chicago" />
            </Field>
          </PanelSection>

          <PanelSection title="Schedules">
            {data.policies.map((p) => {
              if (p.source === 'receipt_settings') {
                return (
                  <div key={p.key} className={s.policyRow}>
                    <div>
                      <b>{p.label}</b>
                      <div className="t-cap">{p.cadenceText}</div>
                    </div>
                    <div className="ink-2" style={{ gridColumn: 'span 5' }}>
                      From <a href="/settings">Settings → Receipt Chase</a> (one place for it). Escalates after {p.escalateAfter ?? '—'}.
                    </div>
                  </div>
                );
              }
              const d = drafts[p.key];
              if (!d) return null;
              const preview = parseDayList(d.days);
              const rep = intOrNull(d.repeatDays, 1, 365);
              return (
                <div key={p.key} className={s.policyRow}>
                  <div>
                    <b>{p.label}</b>
                    <div className="t-cap">
                      {preview ? describeCadence({ offsetsMinutes: preview, repeatEveryMinutes: typeof rep === 'number' ? rep * DAY : null }, p.anchor) : p.cadenceText}
                    </div>
                    {p.source === 'tenant' && <Tag>Customized</Tag>}
                  </div>
                  <Field label={p.anchor === 'due' ? 'Days from due (−30 = before)' : 'Ask on day'} error={errs[`${p.key}.days`]}>
                    <Input value={d.days} disabled={!editable} onChange={(e) => setDrafts({ ...drafts, [p.key]: { ...d, days: e.target.value } })} />
                  </Field>
                  <Field label="Then every (days)" error={errs[`${p.key}.repeat`]}>
                    <Input value={d.repeatDays} disabled={!editable} inputMode="numeric" onChange={(e) => setDrafts({ ...drafts, [p.key]: { ...d, repeatDays: e.target.value } })} />
                  </Field>
                  <Field label="Max asks" error={errs[`${p.key}.max`]}>
                    <Input value={d.max} disabled={!editable} inputMode="numeric" onChange={(e) => setDrafts({ ...drafts, [p.key]: { ...d, max: e.target.value } })} />
                  </Field>
                  <Field label="Escalate after" error={errs[`${p.key}.esc`]}>
                    <Input value={d.escalate} disabled={!editable} inputMode="numeric" onChange={(e) => setDrafts({ ...drafts, [p.key]: { ...d, escalate: e.target.value } })} />
                  </Field>
                  <div>
                    {p.supportsAutoCreate ? (
                      <Switch
                        label="Ask automatically"
                        checked={d.autoCreate}
                        disabled={!editable}
                        onChange={(e) => setDrafts({ ...drafts, [p.key]: { ...d, autoCreate: e.target.checked } })}
                      />
                    ) : (
                      <span className="t-cap">Created by people</span>
                    )}
                  </div>
                </div>
              );
            })}
            <p className="t-cap" style={{ marginTop: 12 }}>
              “Ask automatically” emails vendors whose W-9 or certificate is missing or expiring, every night, without anyone clicking. It is off until you turn it on.
            </p>
          </PanelSection>
        </>
      )}
    </Drawer>
  );
}
