'use client';

import { usePortalVisibility } from '@/components/portal/staff/PortalVisibilityToggle';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, ConfirmDialog, Field, Input, Select, Switch, Tag, Textarea, WidgetState, count, shortDate } from '@meritbooks/merit-ui';
import { LOG_KIND_WORDS } from '@/lib/pm/ops/labels';
import type { FieldLogRow, LogKind } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, parseNum } from '../common/bits';
import { useOps } from '../common/useOps';

export interface LogsViewProps {
  logs: FieldLogRow[];
  jobs: JobOption[];
  /** Open jobs whose job type keeps daily logs (for "not logged today"). */
  loggedJobIds: string[];
  today: string;
  meUserId: string;
  names: Record<string, string>;
  fixedJobId?: string | null;
}

const KINDS: LogKind[] = ['DAILY', 'INSPECTION', 'SAFETY', 'DELIVERY', 'VISIT'];

/** "Clear, 72° / 55°, rain 0.2 in, weather delay" from the stored jsonb. Pure. */
export function weatherText(w: Record<string, unknown> | null): string | null {
  if (!w) return null;
  const parts: string[] = [];
  if (typeof w.conditions === 'string') parts.push(w.conditions);
  if (typeof w.high_f === 'number' || typeof w.low_f === 'number') parts.push(`${typeof w.high_f === 'number' ? `${w.high_f}°` : '—'} / ${typeof w.low_f === 'number' ? `${w.low_f}°` : '—'}`);
  if (typeof w.precipitation === 'string') parts.push(w.precipitation);
  if (w.delay === true) parts.push('weather delay');
  return parts.length ? parts.join(', ') : null;
}

export function LogsView(p: LogsViewProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [jobFilter, setJobFilter] = useState(p.fixedJobId ?? '');
  const [del, setDel] = useState<FieldLogRow | null>(null);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const shown = p.logs.filter((l) => !jobFilter || l.job_id === jobFilter);
  const byDate = useMemo(() => {
    const m = new Map<string, FieldLogRow[]>();
    for (const l of shown) m.set(l.log_date, [...(m.get(l.log_date) ?? []), l]);
    return [...m.entries()];
  }, [shown]);
  const loggedToday = new Set(p.logs.filter((l) => l.log_date === p.today).map((l) => l.job_id));
  const missing = p.fixedJobId ? [] : p.loggedJobIds.filter((id) => !loggedToday.has(id)).map((id) => jobs.get(id)).filter((j): j is JobOption => !!j);

  // On a job's Logs tab: "Show on portal" per entry (1118 client_visible).
  const portal = usePortalVisibility('field_logs', p.fixedJobId ? p.logs.map((l) => l.id) : [], !!p.fixedJobId);
  return (
    <div className="stack">
      {!readOnly && <NewLog jobs={p.jobs.filter((j) => j.open)} fixedJobId={p.fixedJobId} defaultJobId={jobFilter} today={p.today} busy={busy === 'add'} onSave={(b) => act('add', 'post', '/api/ops/logs', b, 'Saved the log')} />}
      <Failure text={error} />
      {missing.length > 0 && (
        <p className="t-cap">Not logged today: {missing.slice(0, 8).map((j, i) => <span key={j.id}>{i > 0 ? ', ' : ''}<button type="button" className="nlink" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => setJobFilter(j.id)}>{j.label}</button></span>)}{missing.length > 8 ? ` and ${missing.length - 8} more` : ''}.</p>
      )}
      <div className="ops-toolbar">
        {!p.fixedJobId && <Field label={v.job}><JobSelect jobs={p.jobs.filter((j) => p.logs.some((l) => l.job_id === j.id))} value={jobFilter} onChange={setJobFilter} placeholder={`Every ${lower(v.job)}`} /></Field>}
        <span className="sp" />
        <span className="t-cap">{count(shown.length)} logs</span>
      </div>
      <div className="mp-table">
        {shown.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: `No ${lower(v.daily_logs)} yet`, body: 'Record each day on site: crew on site, hours, weather and what happened. It is the record when a dispute or a delay claim comes up.' }} />
        ) : byDate.map(([d, ls]) => (
          <section key={d} aria-label={d}>
            <div className="row" style={{ padding: '8px 16px', background: 'var(--canvas)', borderBottom: '1px solid var(--line)', gap: 12 }}>
              <span className="b">{d === p.today ? 'Today' : shortDate(d, p.today)}</span><span className="t-cap">{count(ls.length)} {ls.length === 1 ? 'log' : 'logs'}</span>
            </div>
            <ul className="feed">
              {ls.map((l) => {
                const shownOnPortal = portal.map ? portal.map[l.id] === true : null;
                const w = weatherText(l.weather);
                return (
                  <li key={l.id} style={{ alignItems: 'start', paddingTop: 10, paddingBottom: 10 }}>
                    <span style={{ minWidth: 0 }}>
                      <span className="l1">
                        {!p.fixedJobId && <Link className="nlink" href={`/jobs/${l.job_id}?tab=logs`}>{jobs.get(l.job_id)?.label ?? v.job}</Link>}
                        {!p.fixedJobId && ' · '}{LOG_KIND_WORDS[l.kind]}
                        {w?.includes('weather delay') && <> <Tag tone="warn">Weather delay</Tag></>}
                      </span>
                      <span className="l2">{[w, l.crew_count != null ? `${l.crew_count} on site` : null, l.hours != null ? `${Number(l.hours)} hours` : null, l.created_by ? p.names[l.created_by] ?? (l.created_by === p.meUserId ? 'You' : null) : null].filter(Boolean).join(' · ')}</span>
                      {l.body && <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{l.body}</p>}
                    </span>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="t">{stamp(l.created_at)}</span>
                      {p.fixedJobId && shownOnPortal !== null && (
                        <Switch checked={shownOnPortal} disabled={readOnly} onChange={(e) => void portal.set(l.id, e.target.checked)} label="On portal" />
                      )}
                      {!readOnly && l.created_by === p.meUserId && <Button variant="quiet" iconOnly icon="x" aria-label="Delete log" onClick={() => setDel(l)} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} tone="danger" title="Delete this log" confirmLabel="Delete"
        onConfirm={async () => { if (!del) return; const r = await act('del', 'delete', `/api/ops/logs/${del.id}`, undefined, 'Deleted the log'); if (!r) throw new Error('Not deleted.'); }}>
        {del ? `${LOG_KIND_WORDS[del.kind]} log for ${shortDate(del.log_date, p.today)}. Logs are the site record; delete only one entered by mistake.` : null}
      </ConfirmDialog>
    </div>
  );
}

function NewLog({ jobs, fixedJobId, defaultJobId, today, busy, onSave }: { jobs: JobOption[]; fixedJobId?: string | null; defaultJobId: string; today: string; busy: boolean; onSave: (b: Record<string, unknown>) => Promise<unknown> }) {
  const v = useVocab();
  const [jobId, setJobId] = useState(fixedJobId ?? defaultJobId);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<LogKind>('DAILY');
  const [cond, setCond] = useState('');
  const [hi, setHi] = useState('');
  const [lo, setLo] = useState('');
  const [precip, setPrecip] = useState('');
  const [delay, setDelay] = useState(false);
  const [crew, setCrew] = useState('');
  const [hrs, setHrs] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch' }} onSubmit={(e) => {
      e.preventDefault();
      const id = fixedJobId ?? jobId;
      if (!id) return setErr(`Pick the ${lower(v.job)}.`);
      if (!body.trim() && !crew && !hrs && !cond.trim()) return setErr('Write what happened, or record the crew, hours or weather.');
      setErr(null);
      void onSave({ jobId: id, logDate: date, kind, body: body.trim() || null, crewCount: parseNum(crew), hours: parseNum(hrs), weather: { conditions: cond.trim() || null, highF: parseNum(hi), lowF: parseNum(lo), precipitation: precip.trim() || null, delay } })
        .then((r) => { if (r) { setBody(''); setCrew(''); setHrs(''); } });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!fixedJobId && <Field label={v.job} error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
        <Field label="Date"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as LogKind)}>{KINDS.map((k) => <option key={k} value={k}>{LOG_KIND_WORDS[k]}</option>)}</Select></Field>
        <Field label="On site"><Input inputMode="numeric" value={crew} onChange={(e) => setCrew(e.target.value)} placeholder="6" style={{ width: 72 }} /></Field>
        <Field label="Hours"><Input inputMode="decimal" value={hrs} onChange={(e) => setHrs(e.target.value)} placeholder="48" style={{ width: 80 }} /></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Weather"><Input value={cond} onChange={(e) => setCond(e.target.value)} placeholder="Clear, windy" maxLength={80} style={{ width: 180 }} /></Field>
        <Field label="High °F"><Input inputMode="numeric" value={hi} onChange={(e) => setHi(e.target.value)} style={{ width: 72 }} /></Field>
        <Field label="Low °F"><Input inputMode="numeric" value={lo} onChange={(e) => setLo(e.target.value)} style={{ width: 72 }} /></Field>
        <Field label="Precipitation"><Input value={precip} onChange={(e) => setPrecip(e.target.value)} placeholder="0.2 in rain" maxLength={40} style={{ width: 130 }} /></Field>
        <Check label="Weather delay" checked={delay} onChange={(e) => setDelay(e.target.checked)} />
      </div>
      <Field label="What happened" error={fixedJobId ? err ?? undefined : undefined}><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} placeholder="Framing inspection passed. Drywall delivered to the second floor." /></Field>
      <div><Button type="submit" variant="primary" icon="plus" disabled={busy}>Save log</Button></div>
    </form>
  );
}
