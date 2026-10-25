'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Check, Field, Input, Select, Tag, Textarea, WidgetState, count } from '@meritbooks/merit-ui';
import { DAILY_LOG_STATUS, DELAY_CAUSE } from '@/lib/commercial/labels';
import { LOG_ENTRY_KINDS, LOG_ENTRY_WORDS, type DailyLogRow, type LogEntryKind, type LogEntryRow } from '@/lib/commercial/types';
import type { ProposedEntry } from '@/lib/commercial/voice';
import { stamp } from '@/lib/time';
import { useShell } from '@/components/shell/ShellContext';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, Mk } from './common';

type Act = ReturnType<typeof useOps>['act'];

/**
 * The superintendent's daily log (CGC-70, CGC-71): weather, manpower by company and trade, equipment,
 * deliveries, delays with their cause and who is responsible, inspections and visitors. Signed
 * logs lock; changes after that are amendments kept beside the original with a reason. Talking
 * (or pasting) the day proposes entries for review before anything is written.
 */
export function DailyLogView({ log, entries, jobLabel, jobId, directory }: { log: DailyLogRow; entries: LogEntryRow[]; jobLabel: string; jobId: string; directory: Array<{ vendorId: string | null; name: string; trade: string | null }> }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const draft = log.status === 'DRAFT';
  const url = `/api/commercial/daily-logs/${log.id}`;
  const heads = entries.filter((e) => e.kind === 'MANPOWER').reduce((s, e) => s + Number(e.headcount ?? 0), 0);
  const hours = entries.filter((e) => e.kind === 'MANPOWER').reduce((s, e) => s + Number(e.hours ?? 0), 0);
  const delays = entries.filter((e) => e.kind === 'DELAY');
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="ops-facts">
        <span><Mk map={DAILY_LOG_STATUS} status={log.status} /></span>
        <span><b>{count(heads)}</b> on site</span>
        <span><b>{hours}</b> hours</span>
        {delays.length > 0 && <span><Tag tone="warn">{count(delays.length)} {delays.length === 1 ? 'delay' : 'delays'}</Tag></span>}
        {log.signed_at && <span>Signed by <b>{log.signed_by_name ?? 'the superintendent'}</b>, {stamp(log.signed_at)}</span>}
        {log.amended_count > 0 && <span>{count(log.amended_count)} {log.amended_count === 1 ? 'amendment' : 'amendments'}</span>}
        <span><Link className="link" href={`/jobs/${jobId}?tab=logs`}>{jobLabel}</Link></span>
      </div>
      <Failure text={error} />
      <Header log={log} editable={draft && !readOnly} busy={busy} act={act} url={url} />
      <DSection title="Entries" aside={<span className="t-cap">{count(entries.length)}</span>}>
        {entries.length === 0 ? <p className="t-cap">Nothing recorded yet. Start with who is on site.</p> : (
          <table className="ops-mini">
            <thead><tr><th>Kind</th><th>Who / what</th><th className="n">People</th><th className="n">Hours</th><th>Detail</th>{draft && !readOnly && <th />}</tr></thead>
            <tbody>{LOG_ENTRY_KINDS.concat(['WORK'] as LogEntryKind[]).flatMap((k) => entries.filter((e) => e.kind === k)).map((e) => (
              <tr key={e.id}>
                <td>{LOG_ENTRY_WORDS[e.kind]}{e.is_amendment && <> <Tag>Amendment</Tag></>}</td>
                <td>{e.company_name ?? e.supplier ?? e.equipment ?? e.inspector ?? '—'}{e.trade && <span className="ops-sub" style={{ display: 'block' }}>{e.trade}</span>}</td>
                <td className="n">{e.headcount ?? '—'}</td>
                <td className="n">{e.hours ?? e.equipment_hours ?? e.duration_hours ?? '—'}</td>
                <td>{[e.cause ? DELAY_CAUSE[e.cause] ?? e.cause : null, e.result, e.responsible_party ? `Responsible: ${e.responsible_party}` : null, e.description].filter(Boolean).join(' · ') || '—'}
                  {e.amendment_reason && <span className="ops-sub" style={{ display: 'block' }}>Why: {e.amendment_reason}</span>}</td>
                {draft && !readOnly && <td><Button variant="quiet" iconOnly icon="x" aria-label="Remove entry" disabled={busy !== null} onClick={() => void act(`rm${e.id}`, 'post', url, { op: 'remove_entry', entryId: e.id }, 'Removed')} /></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
        {!readOnly && <EntryForm mode={draft ? 'entry' : 'amend'} busy={busy} directory={directory} onSave={(entry, reason) => act('entry', 'post', url, draft ? { op: 'entry', entry } : { op: 'amend', reason, entry }, draft ? 'Added' : 'Amendment recorded')} />}
      </DSection>
      {draft && !readOnly && <Voice url={url} busy={busy} act={act} />}
      {draft && !readOnly && <Sign url={url} busy={busy} act={act} />}
    </div>
  );
}

function Header({ log, editable, busy, act, url }: { log: DailyLogRow; editable: boolean; busy: string | null; act: Act; url: string }) {
  const [w, setW] = useState(log.weather_summary ?? '');
  const [hi, setHi] = useState(log.temp_high_f != null ? String(log.temp_high_f) : '');
  const [lo, setLo] = useState(log.temp_low_f != null ? String(log.temp_low_f) : '');
  const [precip, setPrecip] = useState(log.precipitation ?? '');
  const [wind, setWind] = useState(log.wind ?? '');
  const [site, setSite] = useState(log.site_conditions ?? '');
  const [work, setWork] = useState(log.work_performed ?? '');
  const [safety, setSafety] = useState(log.safety_notes ?? '');
  const num = (s: string) => (s.trim() && /^-?\d+$/.test(s.trim()) ? Number(s) : null);
  if (!editable) {
    return (
      <DSection title="The day">
        <p className="t-cap">{[log.weather_summary, log.temp_high_f != null ? `${log.temp_high_f}° / ${log.temp_low_f ?? '—'}°` : null, log.precipitation, log.wind].filter(Boolean).join(' · ') || 'No weather recorded.'}</p>
        {log.work_performed && <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{log.work_performed}</p>}
        {log.safety_notes && <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>Safety: {log.safety_notes}</p>}
      </DSection>
    );
  }
  return (
    <DSection title="The day">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Weather"><Input value={w} onChange={(e) => setW(e.target.value)} maxLength={120} placeholder="Clear, windy" style={{ width: 160 }} /></Field>
        <Field label="High °F"><Input inputMode="numeric" value={hi} onChange={(e) => setHi(e.target.value)} style={{ width: 70 }} /></Field>
        <Field label="Low °F"><Input inputMode="numeric" value={lo} onChange={(e) => setLo(e.target.value)} style={{ width: 70 }} /></Field>
        <Field label="Precipitation"><Input value={precip} onChange={(e) => setPrecip(e.target.value)} maxLength={60} style={{ width: 120 }} /></Field>
        <Field label="Wind"><Input value={wind} onChange={(e) => setWind(e.target.value)} maxLength={60} style={{ width: 110 }} /></Field>
      </div>
      <Field label="Site conditions"><Input value={site} onChange={(e) => setSite(e.target.value)} maxLength={2000} placeholder="Muddy at the east gate" /></Field>
      <Field label="Work performed"><Textarea value={work} onChange={(e) => setWork(e.target.value)} rows={4} maxLength={20000} /></Field>
      <Field label="Safety"><Textarea value={safety} onChange={(e) => setSafety(e.target.value)} rows={2} maxLength={4000} /></Field>
      <div><Button disabled={busy !== null} onClick={() => void act('header', 'post', url, {
        op: 'header', weatherSummary: w.trim() || null, tempHighF: num(hi), tempLowF: num(lo), precipitation: precip.trim() || null, wind: wind.trim() || null,
        siteConditions: site.trim() || null, workPerformed: work.trim() || null, safetyNotes: safety.trim() || null,
      }, 'Saved')}>{busy === 'header' ? 'Saving…' : 'Save'}</Button></div>
    </DSection>
  );
}

function EntryForm({ mode, busy, directory, onSave }: { mode: 'entry' | 'amend'; busy: string | null; directory: Array<{ vendorId: string | null; name: string; trade: string | null }>; onSave: (entry: Record<string, unknown>, reason: string) => Promise<unknown> }) {
  const [kind, setKind] = useState<LogEntryKind>('MANPOWER');
  const [company, setCompany] = useState('');
  const [trade, setTrade] = useState('');
  const [heads, setHeads] = useState('');
  const [hours, setHours] = useState('');
  const [what, setWhat] = useState('');
  const [desc, setDesc] = useState('');
  const [cause, setCause] = useState('WEATHER');
  const [resp, setResp] = useState('');
  const [result, setResult] = useState('PASS');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const n = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : null);
  const dir = directory.find((d) => d.name === company);
  return (
    <form className="stack" style={{ gap: 8, marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (mode === 'amend' && !reason.trim()) return setErr('Say why the signed log is amended.');
      if (kind === 'MANPOWER' && !company.trim()) return setErr('Which company?');
      setErr(null);
      const entry: Record<string, unknown> = { kind, description: desc.trim() || null };
      if (kind === 'MANPOWER') Object.assign(entry, { companyName: company.trim(), vendorId: dir?.vendorId ?? null, trade: trade.trim() || dir?.trade || null, headcount: n(heads), hours: n(hours) });
      if (kind === 'EQUIPMENT') Object.assign(entry, { equipment: what.trim() || null, equipmentHours: n(hours) });
      if (kind === 'DELIVERY') Object.assign(entry, { supplier: what.trim() || null });
      if (kind === 'DELAY') Object.assign(entry, { cause, durationHours: n(hours), responsibleParty: resp.trim() || null });
      if (kind === 'INSPECTION') Object.assign(entry, { inspector: what.trim() || null, result });
      if (kind === 'VISITOR') Object.assign(entry, { companyName: what.trim() || null });
      void onSave(entry, reason.trim()).then((r) => { if (r) { setHeads(''); setHours(''); setDesc(''); setWhat(''); setReason(''); } });
    }}>
      {mode === 'amend' && <p className="t-cap">The log is signed. What you add here is an amendment, kept with who, when and why.</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Add" error={err ?? undefined}><Select value={kind} onChange={(e) => setKind(e.target.value as LogEntryKind)}>{LOG_ENTRY_KINDS.map((k) => <option key={k} value={k}>{LOG_ENTRY_WORDS[k]}</option>)}</Select></Field>
        {kind === 'MANPOWER' && <>
          <Field label="Company"><Input list="cm-dir" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} style={{ width: 170 }} /></Field>
          <datalist id="cm-dir">{directory.map((d) => <option key={d.name} value={d.name} />)}</datalist>
          <Field label="Trade"><Input value={trade} onChange={(e) => setTrade(e.target.value)} maxLength={80} placeholder={dir?.trade ?? ''} style={{ width: 120 }} /></Field>
          <Field label="People"><Input inputMode="numeric" value={heads} onChange={(e) => setHeads(e.target.value)} style={{ width: 70 }} /></Field>
          <Field label="Hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 70 }} /></Field>
        </>}
        {(kind === 'EQUIPMENT' || kind === 'DELIVERY' || kind === 'INSPECTION' || kind === 'VISITOR') && (
          <Field label={kind === 'EQUIPMENT' ? 'Equipment' : kind === 'DELIVERY' ? 'Supplier' : kind === 'INSPECTION' ? 'Inspector' : 'Visitor'}><Input value={what} onChange={(e) => setWhat(e.target.value)} maxLength={120} style={{ width: 170 }} /></Field>
        )}
        {kind === 'EQUIPMENT' && <Field label="Hours"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 70 }} /></Field>}
        {kind === 'DELAY' && <>
          <Field label="Cause"><Select value={cause} onChange={(e) => setCause(e.target.value)}>{Object.entries(DELAY_CAUSE).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</Select></Field>
          <Field label="Hours lost"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 80 }} /></Field>
          <Field label="Responsible"><Input value={resp} onChange={(e) => setResp(e.target.value)} maxLength={120} placeholder="Owner, design team, sub" style={{ width: 160 }} /></Field>
        </>}
        {kind === 'INSPECTION' && <Field label="Result"><Select value={result} onChange={(e) => setResult(e.target.value)}><option value="PASS">Passed</option><option value="FAIL">Failed</option><option value="PARTIAL">Partial</option></Select></Field>}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Detail"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4000} style={{ width: 360 }} /></Field>
        {mode === 'amend' && <Field label="Why"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} style={{ width: 240 }} /></Field>}
        <Button type="submit" disabled={busy !== null}>{mode === 'amend' ? 'Add amendment' : 'Add'}</Button>
      </div>
    </form>
  );
}

function Voice({ url, busy, act }: { url: string; busy: string | null; act: Act }) {
  const [text, setText] = useState('');
  const [lang, setLang] = useState<'en' | 'es'>('en');
  const [proposal, setProposal] = useState<{ voiceId: string; proposed: ProposedEntry[] } | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  return (
    <DSection title="Talk through the day">
      <p className="t-cap">Dictate with the phone keyboard or paste notes, in English or Spanish. Nothing is written until you pick what to keep.</p>
      {!proposal ? (
        <div className="stack" style={{ gap: 8 }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={20000} placeholder="Drywall Pros had 5 guys for 8 hours. We waited 2 hours on the inspector. Graybar delivered conduit." />
          <div className="row" style={{ gap: 8 }}>
            <Select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'es')}><option value="en">English</option><option value="es">Español</option></Select>
            <Button disabled={text.trim().length < 3 || busy !== null} onClick={async () => {
              const r = await act<{ voiceId: string; proposed: ProposedEntry[] }>('voice', 'post', url, { op: 'voice', transcript: text.trim(), language: lang }, (d) => `Found ${d.proposed.length} entries to review`);
              if (r) { setProposal(r); setKeep(new Set(r.proposed.map((_, i) => i))); }
            }}>{busy === 'voice' ? 'Reading…' : 'Propose entries'}</Button>
          </div>
        </div>
      ) : proposal.proposed.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'Nothing to propose', body: 'Try naming the company, how many people and hours, and any delay or delivery.' }} />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <ul className="ops-checks">{proposal.proposed.map((p, i) => (
            <li key={i}>
              <Check aria-label={`Keep entry ${i + 1}`} checked={keep.has(i)} onChange={(e) => { const n = new Set(keep); if (e.target.checked) n.add(i); else n.delete(i); setKeep(n); }} />
              <span><span className="b">{p.kind === 'WORK_SUMMARY' ? 'Work performed' : LOG_ENTRY_WORDS[p.kind as LogEntryKind] ?? p.kind}</span>{' '}
                {[p.company_name, p.headcount != null ? `${p.headcount} people` : null, p.hours != null ? `${p.hours} h` : null, p.supplier, p.equipment, p.cause ? DELAY_CAUSE[p.cause] : null, p.duration_hours != null && p.kind === 'DELAY' ? `${p.duration_hours} h lost` : null, p.result].filter(Boolean).join(' · ')}
                <span className="ops-sub" style={{ display: 'block' }}>“{p.source}”</span></span>
              <span className="t-cap">{p.confidence >= 0.8 ? 'Sure' : 'Check'}</span>
            </li>
          ))}</ul>
          <div className="row" style={{ gap: 8 }}>
            <Button variant="primary" disabled={keep.size === 0 || busy !== null} onClick={async () => {
              const entries = proposal.proposed.filter((_, i) => keep.has(i));
              const r = await act<{ applied: number }>('apply', 'post', url, { op: 'apply_voice', voiceId: proposal.voiceId, entries }, (d) => `Added ${d.applied} entries`);
              if (r) { setProposal(null); setText(''); }
            }}>Keep {count(keep.size)}</Button>
            <Button variant="quiet" onClick={() => setProposal(null)}>Start over</Button>
          </div>
        </div>
      )}
    </DSection>
  );
}

function Sign({ url, busy, act }: { url: string; busy: string | null; act: Act }) {
  const [name, setName] = useState('');
  return (
    <DSection title="Sign">
      <p className="t-cap">Signing locks the log. Changes after that are amendments with a reason, so the record holds up in a dispute.</p>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={{ width: 200 }} /></Field>
        <Button variant="primary" disabled={!name.trim() || busy !== null} onClick={() => void act('sign', 'post', url, { op: 'sign', signerName: name.trim() }, 'Signed and locked')}>{busy === 'sign' ? 'Signing…' : 'Sign the log'}</Button>
      </div>
    </DSection>
  );
}
