'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineNotice, Input, Select, Status, Tag, Switch, WidgetState, count, pct } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { CallLogRow, CallReportRow, PhoneProviderRow } from '@/lib/fieldservice/completion-types';
import { PROVIDER_LABEL, type VoiceProvider } from '@/lib/fieldservice/telephony';
import { fmtPhone, fmtWhen, useAction, words } from '../common/useAction';

export interface ProviderState {
  provider: VoiceProvider;
  connected: boolean;
  missing: string[];
  row: PhoneProviderRow | null;
}

export interface CallLogProps {
  companyId: string;
  calls: CallLogRow[];
  callsError: string | null;
  providers: ProviderState[];
  report: CallReportRow[];
  customers: Record<string, string>;
  campaigns: Record<string, string>;
  /** Recent calls the CSR logged (to link a recording to). */
  serviceCalls: Array<{ id: string; label: string }>;
  canConfigure: boolean;
  canLink: boolean;
}

const OUTCOME: Record<CallLogRow['outcome'], { kind: 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'; word: string }> = {
  ANSWERED: { kind: 'ready', word: 'Answered' }, IN_PROGRESS: { kind: 'track', word: 'On the line' }, MISSED: { kind: 'overdue', word: 'Missed' },
  VOICEMAIL: { kind: 'risk', word: 'Voicemail' }, ABANDONED: { kind: 'overdue', word: 'Hung up' }, BUSY: { kind: 'risk', word: 'Busy' }, FAILED: { kind: 'blocked', word: 'Failed' },
};

const dur = (s: number | null) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/**
 * Call log and tracking numbers (FS-05): every provider call with the customer it matched, the
 * campaign its tracking number belongs to and the call / visit it booked; calls by campaign;
 * the phone providers (off until the server holds their credentials).
 */
export function CallLog(p: CallLogProps) {
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [filter, setFilter] = useState<'all' | 'missed' | 'unlinked'>('all');
  const [linking, setLinking] = useState<string | null>(null);
  const [linkTo, setLinkTo] = useState('');
  const rows = useMemo(() => p.calls.filter((c) => filter === 'all' ? true : filter === 'missed' ? ['MISSED', 'ABANDONED', 'VOICEMAIL'].includes(c.outcome) : !c.service_call_id && !c.work_order_id), [p.calls, filter]);
  const missed = p.calls.filter((c) => ['MISSED', 'ABANDONED', 'VOICEMAIL'].includes(c.outcome)).length;
  const anyActive = p.providers.some((x) => x.row?.status === 'ACTIVE');

  return (
    <div className="stack">
      {error && <InlineNotice tone="neg" title="That did not go through.">{error}</InlineNotice>}
      {!anyActive && (
        <InlineNotice tone="info" title="No phone system is connected yet.">
          Calls appear here once RingCentral, Dialpad or Twilio Voice is connected below. Tracking numbers come from each campaign&rsquo;s tracking phone.
        </InlineNotice>
      )}
      <section className="fs-card" aria-label="Calls">
        <div className="fs-card-h">
          <h2 className="t-section">01 // Calls</h2><span className="sp" />
          <div className="fs-flags" role="group" aria-label="Show">
            {(['all', 'missed', 'unlinked'] as const).map((f) => (
              <Button key={f} variant={filter === f ? 'primary' : 'quiet'} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {f === 'all' ? `All ${count(p.calls.length)}` : f === 'missed' ? `Missed ${count(missed)}` : 'Not linked'}
              </Button>
            ))}
          </div>
        </div>
        {p.callsError ? <div className="fs-card-b"><WidgetState state={{ kind: 'error', title: 'The call log did not load', body: p.callsError }} /></div>
          : rows.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: filter === 'all' ? 'No calls recorded yet' : 'Nothing here', body: 'Recorded calls from the connected phone system land here within seconds.' }} /></div>
          : (
            <div className="fs-scroll">
              <table className="fs-table">
                <thead><tr><th>When</th><th>Caller</th><th>Campaign</th><th>Result</th><th className="n">Length</th><th>Booked</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="fs-mono">{fmtWhen(c.started_at)}<span className="l2">{c.direction === 'OUTBOUND' ? 'Outbound' : 'Inbound'} · {PROVIDER_LABEL[c.provider]}</span></td>
                      <td>{c.customer_id ? <span className="l1">{p.customers[c.customer_id] ?? 'Customer'}</span> : <span className="l1">New caller</span>}
                        <span className="l2">{fmtPhone(c.direction === 'OUTBOUND' ? c.to_number : c.from_number)}</span></td>
                      <td>{c.campaign_id ? <Tag tone="ai">{p.campaigns[c.campaign_id] ?? 'Campaign'}</Tag> : <span className="fs-muted">—</span>}</td>
                      <td><Status kind={OUTCOME[c.outcome].kind}>{OUTCOME[c.outcome].word}</Status>{c.recording_ref && <span className="l2">Recorded</span>}</td>
                      <td className="n">{dur(c.duration_seconds)}</td>
                      <td>{c.work_order_id ? <Link href={`/dispatch/visit/${c.work_order_id}`}>Visit</Link> : c.service_call_id ? <span>Call logged</span> : <span className="fs-muted">—</span>}</td>
                      <td>
                        {p.canLink && !readOnly && !c.service_call_id && (linking === c.id ? (
                          <div className="fs-flags">
                            <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} aria-label="Logged call">
                              <option value="">Pick the logged call</option>
                              {p.serviceCalls.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                            </Select>
                            <Button variant="primary" disabled={!linkTo || busy === c.id}
                              onClick={() => void run(c.id, '/api/fieldservice/telephony', { op: 'link', callId: c.id, serviceCallId: linkTo }, 'Linked').then(() => { setLinking(null); setLinkTo(''); })}>Link</Button>
                          </div>
                        ) : <Button variant="quiet" onClick={() => setLinking(c.id)}>Link</Button>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className="fs-card" aria-label="Calls by campaign">
        <div className="fs-card-h"><h2 className="t-section">02 // Calls by tracking number</h2><span className="sp" /><span className="t-cap">Last 30 days · inbound</span></div>
        {p.report.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No inbound calls yet', body: 'Give each campaign a tracking phone; its calls add up here with the booked rate.' }} /></div> : (
          <table className="fs-table">
            <thead><tr><th>Campaign</th><th className="n">Calls</th><th className="n">Answered</th><th className="n">Missed</th><th className="n">Booked</th><th className="n">Booked rate</th></tr></thead>
            <tbody>{p.report.map((r) => (
              <tr key={r.campaign_id ?? 'none'}><td>{r.campaign}</td><td className="n">{count(r.calls)}</td><td className="n">{count(r.answered)}</td>
                <td className="n">{count(r.missed)}</td><td className="n">{count(r.booked)}</td><td className="n">{r.booked_rate == null ? '—' : pct(r.booked_rate)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="fs-card" aria-label="Phone system">
        <div className="fs-card-h"><h2 className="t-section">03 // Phone system</h2><span className="sp" /><span className="t-cap">Recordings stay with the provider; the log keeps their reference</span></div>
        <div className="fs-card-b">
          {p.providers.map((x) => <ProviderRow key={x.provider} companyId={p.companyId} state={x} canConfigure={p.canConfigure && !readOnly} />)}
        </div>
      </section>
    </div>
  );
}

function ProviderRow({ companyId, state, canConfigure }: { companyId: string; state: ProviderState; canConfigure: boolean }) {
  const { run, busy, error } = useAction();
  const [numbers, setNumbers] = useState((state.row?.main_numbers ?? []).join(', '));
  const active = state.row?.status === 'ACTIVE';
  const save = (on: boolean) => run(state.provider, '/api/fieldservice/telephony', {
    op: 'provider', companyId, provider: state.provider, active: on,
    mainNumbers: numbers.split(',').map((n) => n.trim()).filter(Boolean),
  }, on ? `${PROVIDER_LABEL[state.provider]} is on` : `${PROVIDER_LABEL[state.provider]} is off`);
  return (
    <div className="fs-form" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12, marginBottom: 12 }}>
      <div>
        <div className="l1">{PROVIDER_LABEL[state.provider]} {active ? <Status kind="ready">On</Status> : <Status kind="blocked">Off</Status>}</div>
        <p className="t-cap">{state.connected ? 'Credentials are on the server.' : `Not connected — the server needs ${state.missing.join(', ')}.`}</p>
        {error && <p className="t-cap" role="alert">{error}</p>}
      </div>
      <div className="stack">
        <Field label="Company main numbers" help="Calls to these numbers (and to campaign tracking numbers) are logged">
          <Input value={numbers} onChange={(e) => setNumbers(e.target.value)} disabled={!canConfigure} placeholder="(515) 555-0100" />
        </Field>
        <Switch checked={active} disabled={!canConfigure || busy === state.provider || (!active && !state.connected)} onChange={(e) => void save(e.target.checked)}
          label={active ? 'Recording calls into the log' : 'Switch on'} />
      </div>
    </div>
  );
}
