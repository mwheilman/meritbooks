'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  InlineNotice,
  Input,
  KV,
  Panel,
  PanelSection,
  Pip,
  Select,
  Tag,
  api,
  money,
  toast,
  useQuery,
} from '@meritbooks/merit-ui';
import { VENDOR_TYPE_OPTIONS, actorWord, outcomeLook, relative, rowLook, vendorTypeLabel, type ActionResponse, type DashboardRow, type VendorDetail } from './vc-types';
import s from './vendor-compliance.module.css';

type OverrideType = 'ONE_TIME' | 'TEMPORARY' | 'PERMANENT';
const OVERRIDE_LABEL: Record<OverrideType, string> = { ONE_TIME: 'One-time', TEMPORARY: 'Temporary', PERMANENT: 'Permanent' };
const SUB_WORD: Record<string, string> = { received: 'Received', ai_checked: 'AI-checked', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Replaced' };

export interface VendorPanelProps {
  vendorId: string;
  row: DashboardRow | null;
  refreshKey: number;
  onClose: () => void;
  onRequest: (r: DashboardRow, kind: 'w9' | 'coi') => void;
  onChanged: () => void;
}

/** The selected vendor: requirements vs what's on file, classification, override, documents, timeline. */
export function VendorPanel({ vendorId, row, refreshKey, onClose, onRequest, onChanged }: VendorPanelProps) {
  const { data, error, isLoading, refetch } = useQuery<VendorDetail>('/api/vendor-compliance/vendor', { id: vendorId }, { key: `${vendorId}:${refreshKey}`, scope: false });
  const [vtype, setVtype] = useState('');
  const [wtype, setWtype] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);

  useEffect(() => {
    setVtype(data?.profile?.vendor_type ?? '');
    setWtype(data?.profile?.work_type ?? '');
  }, [data]);

  if (error) {
    return (
      <Panel title="Couldn’t load this vendor" onClose={onClose}>
        <PanelSection>
          <InlineNotice tone="neg" title="Something went wrong.">
            {error}{' '}
            <Button variant="quiet" onClick={() => void refetch()}>
              Try again
            </Button>
          </InlineNotice>
        </PanelSection>
      </Panel>
    );
  }
  if (isLoading || !data) {
    return (
      <Panel title="Loading…" onClose={onClose}>
        <PanelSection>
          <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
          <p className="t-cap" role="status">
            Loading the compliance file…
          </p>
        </PanelSection>
      </Panel>
    );
  }

  const v = data.vendor;
  const name = v.display_name || v.name;
  const look = row ? rowLook(row) : null;

  const saveProfile = async () => {
    if (wtype && !/^[a-z0-9_]{1,40}$/.test(wtype)) {
      toast.error('Work type: lower-case letters, digits and underscores (e.g. roofing).');
      return;
    }
    setSavingProfile(true);
    const res = await api.post<ActionResponse>('/api/vendor-compliance/profile', { vendor_id: vendorId, vendor_type: vtype || null, work_type: wtype || null });
    setSavingProfile(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(res.data?.message ?? 'Saved.');
    onChanged();
  };

  return (
    <Panel
      eyebrow={['Vendor compliance', row?.requirementSet?.name ?? 'Tracked documents']}
      title={name}
      meta={[v.email ?? 'No email on file', vendorTypeLabel(data.profile?.vendor_type)].join(' · ')}
      figure={row ? money(row.openBillsCents) : undefined}
      onClose={onClose}
      foot={
        row ? (
          <div className={s.actions}>
            <Button variant="primary" chord="r" onClick={() => onRequest(row, 'coi')} disabled={!v.email}>
              Request COI
            </Button>
            <Button onClick={() => onRequest(row, 'w9')} disabled={!v.email}>
              Request W-9
            </Button>
            {row.onHold && !row.bankChangePending && (
              <Button variant="quiet" onClick={() => setGrantOpen(true)}>
                Override hold
              </Button>
            )}
            {row.override && (
              <Button variant="quiet" onClick={() => setReleaseOpen(true)}>
                End override
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <PanelSection
        title="Status"
        meta={
          look ? (
            <span className="mb-sev">
              <Pip kind={look.pip} />
              {look.word}
            </span>
          ) : undefined
        }
      >
        {!v.email && (
          <InlineNotice tone="warn" title="No email address.">
            Add one on the vendor so requests can reach them.
          </InlineNotice>
        )}
        {row?.bankChangePending && (
          <InlineNotice tone="neg" title="Bank details changed.">
            Payments are held until someone calls the vendor at a number already on file and records it in Bank changes.
          </InlineNotice>
        )}
        {row?.override && (
          <InlineNotice tone="warn" title={`${OVERRIDE_LABEL[row.override.type as OverrideType] ?? row.override.type} override in place${row.override.endDate ? ` until ${row.override.endDate}` : ''}.`}>
            {row.override.reason}
          </InlineNotice>
        )}
        <p className="ink-2">{row?.headline ?? 'Not in scope for any requirement set.'}</p>
      </PanelSection>

      <PanelSection title="What it owes" meta={row?.nextExpiry ? <span className="t-cap">Next expiry <span className="tnum">{row.nextExpiry}</span></span> : undefined}>
        {row && row.rules.length > 0 ? (
          <ul className={s.checks}>
            {row.rules.map((c) => {
              const o = outcomeLook(c.outcome);
              return (
                <li key={c.id}>
                  <span className="mb-sev">
                    <Pip kind={o.pip} />
                    {o.word}
                  </span>
                  <span>
                    <span className="t-ui">{c.label}</span>
                    <span className="t-cap" style={{ display: 'block' }}>
                      {c.reason}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ink-2">No requirement applies. Classify the vendor or add a requirement set.</p>
        )}
        {row && row.companies.length > 0 && <p className="t-cap" style={{ marginTop: 8 }}>Works for {row.companies.map((c) => c.name).join(', ')}</p>}
      </PanelSection>

      <PanelSection title="Classification">
        <div className={s.formGrid}>
          <Field label="Vendor type" help="Picks the requirement set.">
            <Select value={vtype} onChange={(e) => setVtype(e.target.value)}>
              <option value="">Unclassified</option>
              {VENDOR_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Work type (optional)" help="A tag a requirement set can target, e.g. roofing.">
            <Input value={wtype} onChange={(e) => setWtype(e.target.value.toLowerCase())} placeholder="roofing" />
          </Field>
          <div>
            <Button onClick={() => void saveProfile()} disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save classification'}
            </Button>
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Documents" meta={<span className="t-cap tnum">{data.submissions.length}</span>}>
        {data.submissions.length === 0 ? (
          <p className="ink-2">Nothing received through the portal yet.</p>
        ) : (
          <KV
            items={data.submissions.slice(0, 8).map((d) => ({
              term: `${d.doc_kind === 'W9' ? 'W-9' : 'COI'} · ${d.created_at.slice(0, 10)}`,
              value: (
                <span>
                  <Tag tone={d.status === 'accepted' ? 'pos' : d.status === 'rejected' ? 'neg' : d.status === 'superseded' ? 'default' : 'ai'}>{SUB_WORD[d.status] ?? d.status}</Tag>
                  {d.decision_reason ? <span className="t-cap"> {d.decision_reason}</span> : null}
                </span>
              ),
            }))}
          />
        )}
      </PanelSection>

      <PanelSection title="Timeline" meta={<span className="t-cap tnum">{data.timeline.length}</span>}>
        {data.timeline.length === 0 ? (
          <p className="ink-2">Nothing has happened yet.</p>
        ) : (
          <ul className={s.timeline}>
            {data.timeline.slice(0, 60).map((e, i) => (
              <li key={`${e.at}:${i}`}>
                <i className={`${s.mark} ${e.source === 'request' ? s.markReq : ''} ${/BLOCKED|REJECTED|FAILED|bounced|failed|escalated/.test(e.type) ? s.markBad : ''}`} aria-hidden="true" />
                <div>
                  <div className={s.evHead}>
                    <span className="t-ui">{e.title}</span>
                    <span className="t-cap" title={e.at}>
                      {relative(e.at)}
                    </span>
                  </div>
                  {e.detail && <div className="t-cap">{e.detail}</div>}
                  <div className="t-cap ink-3">{actorWord(e.actor)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {row && <GrantOverrideDialog open={grantOpen} row={row} onClose={() => setGrantOpen(false)} onDone={() => { setGrantOpen(false); onChanged(); }} />}
      <ConfirmDialog
        open={releaseOpen}
        onClose={() => setReleaseOpen(false)}
        title={`End the override for ${name}?`}
        confirmLabel="End override"
        tone="danger"
        reason={{ label: 'Why? (goes on the audit trail)', minLength: 3, placeholder: 'Certificate renewed' }}
        onConfirm={async (reason) => {
          if (!row?.override) return;
          const res = await api.post<ActionResponse>('/api/vendor-compliance', { action: 'release_override', override_id: row.override.id, reason: reason ?? '' });
          setReleaseOpen(false);
          if (res.error) {
            toast.error(res.error.error);
            return;
          }
          toast('Override ended.');
          onChanged();
        }}
      >
        If anything is still missing the vendor goes back on payment hold.
      </ConfirmDialog>
    </Panel>
  );
}

function GrantOverrideDialog({ open, row, onClose, onDone }: { open: boolean; row: DashboardRow; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<OverrideType>('ONE_TIME');
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (reason.trim().length < 3) return setErr('A reason is required (it is recorded on the audit trail).');
    if (type === 'TEMPORARY' && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return setErr('Choose an end date for a temporary override.');
    setBusy(true);
    const res = await api.post('/api/vendor-compliance', { action: 'grant_override', vendor_id: row.vendorId, hold_type: type, reason: reason.trim(), end_date: type === 'TEMPORARY' ? endDate : undefined });
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(`Override granted for ${row.vendorName}.`);
    onDone();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Override the payment hold"
      dismissOnScrim={false}
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Granting…' : 'Grant override'}
          </Button>
        </>
      }
      footNote="Accounting manager or above. Logged with your name and reason. Does not lift a bank-change hold."
    >
      <p className="ink-2" style={{ marginBottom: 12 }}>
        {row.vendorName} is held for: {row.rules.filter((c) => !['met', 'expiring', 'grace'].includes(c.outcome)).map((c) => c.label).join(', ') || 'missing documents'}.
      </p>
      <div className={s.formGrid}>
        <Field label="Override">
          <Select value={type} onChange={(e) => setType(e.target.value as OverrideType)}>
            <option value="ONE_TIME">One payment, then the hold returns</option>
            <option value="TEMPORARY">Until a date</option>
            <option value="PERMANENT">Until someone ends it</option>
          </Select>
        </Field>
        {type === 'TEMPORARY' && <Field label="Until"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>}
        <Field label="Reason" error={err ?? undefined}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Renewal in progress; agent confirmed by phone" />
        </Field>
      </div>
    </Dialog>
  );
}
