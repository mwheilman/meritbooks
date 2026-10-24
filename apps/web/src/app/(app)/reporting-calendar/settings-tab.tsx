'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, Button, Field, Input, InlineNotice, Select, Switch, toast } from '@meritbooks/merit-ui';
import { STANDARD_DEADLINES as STANDARD } from '@/lib/reports/governance/deadlines';
import { type CalendarResponse, type DeadlineDef, type ReleaseSettings } from './types';
import s from './reporting-calendar.module.css';


const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "September 20" — August 31 plus N days. */
function exampleDate(days: number): string {
  const d = new Date(Date.UTC(2026, 7, 31 + (Number.isFinite(days) ? days : 0)));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function RuleForm({
  initial,
  locationId,
  isOverride,
  canEdit,
  onSaved,
}: {
  initial: ReleaseSettings;
  locationId: string | null;
  isOverride: boolean;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [rule, setRule] = useState<ReleaseSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRule(initial), [initial]);

  const daysOk = Number.isInteger(rule.autoReleaseDays) && rule.autoReleaseDays >= 0 && rule.autoReleaseDays <= 120;
  const deadlinesOk = rule.deadlines.every((d) => d.label.trim() && Number.isInteger(d.daysAfterPeriodEnd) && d.daysAfterPeriodEnd >= 0 && d.daysAfterPeriodEnd <= 400);
  const valid = daysOk && deadlinesOk;

  const save = async (clear = false) => {
    setBusy(true);
    setErr(null);
    const res = await api.put('/api/report-governance/settings', {
      location_id: locationId,
      clear,
      auto_release_enabled: rule.autoReleaseEnabled,
      auto_release_days: rule.autoReleaseDays,
      auto_release_min_status: rule.autoReleaseMinStatus,
      deadlines: rule.deadlines.map((d, i) => ({ ...d, key: d.key || `deadline-${i + 1}`, recipient: d.recipient || null })),
    });
    setBusy(false);
    if (res.error) {
      setErr(res.error.error);
      return;
    }
    toast(clear ? 'This company follows the tenant rule again.' : 'Release rule saved.');
    onSaved();
  };

  const setDl = (i: number, patch: Partial<DeadlineDef>) =>
    setRule((r) => ({ ...r, deadlines: r.deadlines.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));

  return (
    <div>
      {err && <InlineNotice className={s.notice} tone="neg" title="Not saved.">{err}</InlineNotice>}
      <Switch
        label="Release months automatically"
        checked={rule.autoReleaseEnabled}
        disabled={!canEdit}
        onChange={(e) => setRule((r) => ({ ...r, autoReleaseEnabled: e.target.checked }))}
      />
      <div className={s.grid3} style={{ marginTop: 12 }}>
        <Field label="Days after month end" error={daysOk ? undefined : 'Between 0 and 120'}>
          <Input
            type="number"
            min={0}
            max={120}
            value={String(rule.autoReleaseDays)}
            disabled={!canEdit || !rule.autoReleaseEnabled}
            onChange={(e) => setRule((r) => ({ ...r, autoReleaseDays: Number(e.target.value) }))}
          />
        </Field>
        <Field label="Only once the month is">
          <Select
            value={rule.autoReleaseMinStatus}
            disabled={!canEdit || !rule.autoReleaseEnabled}
            onChange={(e) => setRule((r) => ({ ...r, autoReleaseMinStatus: e.target.value === 'SOFT_CLOSE' ? 'SOFT_CLOSE' : 'HARD_CLOSE' }))}
          >
            <option value="HARD_CLOSE">Closed (hard close)</option>
            <option value="SOFT_CLOSE">Soft-closed or closed</option>
          </Select>
        </Field>
      </div>
      <p className={s.sentence}>
        {rule.autoReleaseEnabled
          ? `Example: August releases on ${exampleDate(rule.autoReleaseDays)} if it is ${rule.autoReleaseMinStatus === 'HARD_CLOSE' ? 'closed' : 'at least soft-closed'} by then. Until then finance sees it as a preview and partners don't see it.`
          : 'Nothing is shown to partners until someone releases the month.'}
      </p>

      <div className="eyebrow" style={{ margin: '16px 0 8px' }}>Reporting deadlines</div>
      {rule.deadlines.length === 0 && <p className={s.muted}>None. Deadlines show as tiles with the due date and whether the numbers went out on time.</p>}
      {rule.deadlines.map((d, i) => (
        <div key={i} className={s.dlRow}>
          <Field label="Package">
            <Input value={d.label} disabled={!canEdit} maxLength={80} onChange={(e) => setDl(i, { label: e.target.value })} />
          </Field>
          <Field label="Every">
            <Select value={d.cadence} disabled={!canEdit} onChange={(e) => setDl(i, { cadence: e.target.value as DeadlineDef['cadence'] })}>
              <option value="monthly">Month</option>
              <option value="quarterly">Quarter</option>
              <option value="annual">Year</option>
            </Select>
          </Field>
          <Field label="Days after">
            <Input type="number" min={0} max={400} value={String(d.daysAfterPeriodEnd)} disabled={!canEdit} onChange={(e) => setDl(i, { daysAfterPeriodEnd: Number(e.target.value) })} />
          </Field>
          <Field label="For (optional)">
            <Input value={d.recipient ?? ''} disabled={!canEdit} maxLength={120} placeholder="Board, lender…" onChange={(e) => setDl(i, { recipient: e.target.value })} />
          </Field>
          {canEdit && (
            <Button variant="quiet" aria-label={`Remove ${d.label || 'deadline'}`} onClick={() => setRule((r) => ({ ...r, deadlines: r.deadlines.filter((_, j) => j !== i) }))}>
              ×
            </Button>
          )}
        </div>
      ))}
      {canEdit && (
        <div className={s.actions}>
          <Button onClick={() => setRule((r) => ({ ...r, deadlines: [...r.deadlines, { key: '', label: 'Monthly package', cadence: 'monthly', daysAfterPeriodEnd: 30 }] }))} disabled={rule.deadlines.length >= 12}>
            Add a deadline
          </Button>
          {rule.deadlines.length === 0 && <Button variant="quiet" onClick={() => setRule((r) => ({ ...r, deadlines: STANDARD }))}>Use 45 / 60 / 90 days</Button>}
          <span style={{ flex: 1 }} />
          {locationId && isOverride && <Button variant="quiet" onClick={() => void save(true)} disabled={busy}>Use the tenant rule</Button>}
          <Button variant="primary" onClick={() => void save(false)} disabled={busy || !valid} aria-busy={busy || undefined}>
            {locationId ? 'Save for this company' : 'Save release rule'}
          </Button>
        </div>
      )}
    </div>
  );
}

function CoverageForm({ data, locationId, canEdit, onSaved }: { data: CalendarResponse; locationId: string; canEdit: boolean; onSaved: () => void }) {
  const card = data.freshness.find((f) => f.locationId === locationId);
  const [from, setFrom] = useState(card?.inGroupFrom ?? '');
  const [until, setUntil] = useState(card?.inGroupUntil ?? '');
  const [note, setNote] = useState(card?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setFrom(card?.inGroupFrom ?? '');
    setUntil(card?.inGroupUntil ?? '');
    setNote(card?.note ?? '');
  }, [card?.inGroupFrom, card?.inGroupUntil, card?.note, locationId]);
  const datesOk = !from || !until || until >= from;

  const save = async () => {
    setBusy(true);
    setErr(null);
    const res = await api.put('/api/report-governance/coverage', { location_id: locationId, in_group_from: from || null, in_group_until: until || null, note: note.trim() || null });
    setBusy(false);
    if (res.error) {
      setErr(res.error.error);
      return;
    }
    toast('Group dates saved.');
    onSaved();
  };

  return (
    <div>
      {err && <InlineNotice className={s.notice} tone="neg" title="Not saved.">{err}</InlineNotice>}
      <p className={s.sentence}>Consolidated and combined views leave this company out before it joined the group, so trends never mix in months it wasn&apos;t yours. Finance can ask for pro forma figures instead.</p>
      <div className={s.grid3}>
        <Field label="In the group from">
          <Input type="date" value={from} disabled={!canEdit} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Until (if it left)" error={datesOk ? undefined : 'Must be on or after the start'}>
          <Input type="date" value={until} disabled={!canEdit} onChange={(e) => setUntil(e.target.value)} />
        </Field>
        <Field label="Note on the freshness card">
          <Input value={note} disabled={!canEdit} maxLength={500} placeholder="Books from QuickBooks until Mar 2026" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {canEdit && (
        <div className={s.actions}>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !datesOk} aria-busy={busy || undefined}>Save group dates</Button>
        </div>
      )}
    </div>
  );
}

/** The release rule (tenant + per-company override) and in-group dates. */
export function SettingsTab({ data, onChanged }: { data: CalendarResponse; onChanged: () => void }) {
  const [companyId, setCompanyId] = useState<string>(data.calendar.rows[0]?.locationId ?? '');
  const row = useMemo(() => data.calendar.rows.find((r) => r.locationId === companyId) ?? null, [data, companyId]);
  return (
    <div>
      <section className={s.sec} aria-label="Release rule for every company">
        <div className="eyebrow">01 // Release rule — every company</div>
        <RuleForm initial={data.tenantSettings} locationId={null} isOverride={false} canEdit={data.canRelease} onSaved={onChanged} />
      </section>

      {data.calendar.rows.length > 0 && (
        <section className={s.sec} aria-label="One company">
          <div className="eyebrow">02 // One company</div>
          <Field label="Company" className={s.field}>
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              {data.calendar.rows.map((r) => (
                <option key={r.locationId} value={r.locationId}>{r.name}{r.hasOverride ? ' (own rule)' : ''}</option>
              ))}
            </Select>
          </Field>
          {row && (
            <>
              <CoverageForm data={data} locationId={row.locationId} canEdit={data.canRelease} onSaved={onChanged} />
              <div className="eyebrow" style={{ margin: '24px 0 8px' }}>Its own release rule</div>
              <p className={s.sentence}>{row.hasOverride ? 'This company has its own rule.' : 'This company follows the rule above. Saving here gives it its own.'}</p>
              <RuleForm initial={row.settings} locationId={row.locationId} isOverride={row.hasOverride} canEdit={data.canRelease} onSaved={onChanged} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
