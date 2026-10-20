'use client';

import { useMemo, useState } from 'react';
import { AiPaused, Button, Check, Field, InlineNotice, Pip, Select, money, toast } from '@meritbooks/merit-ui';
import { FIELD_DEFS, LOW_CONFIDENCE } from '@/lib/onboarding/import/automap';
import { mapRecords, rowsToCreate, type JobTypeOption } from '@/lib/onboarding/import/rows';
import type { ColumnMapping, CommitRowResult, ImportField, ParseResponse } from '@/lib/onboarding/types';
import { postJson } from './api';

const BATCH = 100;

/** Review the auto-mapped file: only low-confidence columns ask for a look; first 10 rows preview; confirm creates jobs. */
export function ImportReview({ companyId, file, jobTypes, onDone, onCancel }: {
  companyId: string;
  file: ParseResponse;
  jobTypes: JobTypeOption[];
  onDone: (created: CommitRowResult[]) => void;
  onCancel: () => void;
}) {
  const [mapping, setMapping] = useState<ColumnMapping>(file.mapping);
  const [defaultType, setDefaultType] = useState(jobTypes[0]?.key ?? '');
  const [includeFinished, setIncludeFinished] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<CommitRowResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => mapRecords(file.records, file.rowNumbers, mapping, { jobTypes, defaultJobTypeKey: defaultType }),
    [file, mapping, jobTypes, defaultType],
  );
  const toCreate = rowsToCreate(rows, includeFinished);
  const finished = rows.filter((r) => !r.invalid && r.finished).length;
  const invalid = rows.filter((r) => r.invalid).length;
  const low = FIELD_DEFS.filter((d) => mapping[d.key] && mapping[d.key]!.confidence < LOW_CONFIDENCE);

  const setField = (f: ImportField, header: string) => {
    setMapping((m) => {
      const next: ColumnMapping = { ...m };
      for (const k of Object.keys(next) as ImportField[]) if (next[k]?.header === header && k !== f) delete next[k];
      if (header) next[f] = { header, confidence: 1, source: 'user' };
      else delete next[f];
      return next;
    });
  };

  const commit = async () => {
    if (toCreate.length === 0) return;
    setError(null);
    const all: CommitRowResult[] = [];
    setProgress({ done: 0, total: toCreate.length });
    for (let i = 0; i < toCreate.length; i += BATCH) {
      const batch = toCreate.slice(i, i + BATCH).map((r) => ({
        rowNumber: r.rowNumber, name: r.name, externalId: r.externalId, customer: r.customer, jobTypeKey: r.jobTypeKey,
        contractCents: r.contractCents, startDate: r.startDate, statusRaw: r.statusRaw, status: r.status,
        siteAddress: r.siteAddress, sourceRef: r.sourceRef,
      }));
      const res = await postJson<{ results: CommitRowResult[] }>('/api/onboarding/import/commit', {
        companyId, rows: batch, vendor: file.vendor, aiDecisionId: file.aiDecisionId,
      });
      if (!res.ok) {
        setError(`${res.error} ${all.length > 0 ? `${all.filter((r) => r.status === 'created').length} were brought in before this stopped; running it again skips them.` : ''}`);
        break;
      }
      all.push(...res.data.results);
      setProgress({ done: Math.min(i + BATCH, toCreate.length), total: toCreate.length });
    }
    setProgress(null);
    setResults(all);
    const created = all.filter((r) => r.status === 'created').length;
    if (created > 0) toast(`Brought in ${created} ${created === 1 ? 'job' : 'jobs'} from ${file.fileName}`);
    onDone(all);
  };

  if (results) {
    const created = results.filter((r) => r.status === 'created').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'error').length;
    return (
      <section className="ob-card ob-review" aria-labelledby="ob-res">
        <div className="ob-card-h">
          <h3 id="ob-res">{created} {created === 1 ? 'job' : 'jobs'} brought in</h3>
          <span className="sp" />
          <span className="t-cap">{skipped ? `${skipped} already here · ` : ''}{failed ? `${failed} need a look` : 'nothing failed'}</span>
        </div>
        {error && <div className="ob-card-b"><InlineNotice tone="neg" title={error} /></div>}
        <ul className="ob-results">
          {results.map((r) => (
            <li key={r.rowNumber}>
              <span className="t-cap tnum">Row {r.rowNumber}</span>
              <span>
                <span className="l1">{r.name}</span>
                {r.message && <span className="l2">{r.message}</span>}
              </span>
              <span className="status">
                <Pip kind={r.status === 'created' ? 'ready' : r.status === 'skipped' ? 'track' : 'blocked'} />
                {r.status === 'created' ? 'Created' : r.status === 'skipped' ? 'Already here' : 'Not created'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const preview = rows.slice(0, 10);
  return (
    <section className="ob-card ob-review" aria-labelledby="ob-rev">
      <div className="ob-card-h">
        <h3 id="ob-rev">{file.fileName}</h3>
        <span className="t-cap">{file.rowCount.toLocaleString('en-US')} rows{file.vendor ? ` · ${file.vendor} export` : ''}{file.truncated ? ' · first 2,000 read' : ''}</span>
        <span className="sp" />
        <Button variant="quiet" onClick={onCancel}>Use a different file</Button>
      </div>

      {(file.ai.outcome === 'unavailable' || file.ai.outcome === 'blocked') && (
        <div className="ob-card-b"><AiPaused>Columns were matched by their names only. Check the ones marked below.</AiPaused></div>
      )}
      {file.ai.outcome === 'used' && file.ai.mapped > 0 && (
        <div className="ob-card-b"><InlineNotice tone="info" title={`AI matched ${file.ai.mapped} more ${file.ai.mapped === 1 ? 'column' : 'columns'} from the header names and a few rows.`}>They&apos;re marked for a quick look.</InlineNotice></div>
      )}

      <div className="ob-map">
        {FIELD_DEFS.map((d) => {
          const m = mapping[d.key];
          const isLow = m && m.confidence < LOW_CONFIDENCE;
          return (
            <Field
              key={d.key}
              label={`${d.label}${d.required ? ' (needed)' : ''}`}
              help={!m ? 'Not in this file' : isLow ? (m.source === 'ai' ? 'Matched by AI · check it' : 'Best guess · check it') : m.source === 'user' ? 'Your choice' : 'Matched by name'}
              className={isLow ? 'is-low' : undefined}
            >
              <Select value={m?.header ?? ''} onChange={(e) => setField(d.key, e.currentTarget.value)}>
                <option value="">Not used</option>
                {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </Select>
            </Field>
          );
        })}
        <Field label="Job type when the file doesn't say" help="Rows whose type matches yours use it">
          <Select value={defaultType} onChange={(e) => setDefaultType(e.currentTarget.value)}>
            {jobTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
        </Field>
      </div>

      {low.length > 0 && (
        <div className="ob-card-b"><InlineNotice tone="warn" title={`${low.length} ${low.length === 1 ? 'column needs' : 'columns need'} a look: ${low.map((d) => d.label).join(', ')}.`}>Everything else matched by name.</InlineNotice></div>
      )}

      <div className="ob-tbl">
        <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="First 10 rows as they will come in">
          <colgroup><col style={{ width: 72 }} /><col /><col style={{ width: 168 }} /><col style={{ width: 160 }} /><col style={{ width: 120 }} /><col style={{ width: 104 }} /><col style={{ width: 104 }} /><col style={{ width: 220 }} /></colgroup>
          <thead><tr><th>Row</th><th>Job</th><th>Customer</th><th>Job type</th><th className="n">Contract</th><th>Start</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>
            {preview.map((r) => (
              <tr key={r.rowNumber} className={`q-row${r.invalid || (r.finished && !includeFinished) ? ' is-done' : ''}`}>
                <td className="tnum">{r.rowNumber}</td>
                <td><span className="l1">{r.name || '—'}</span>{r.externalId && <span className="l2">{r.externalId}</span>}</td>
                <td>{r.customer ?? '—'}</td>
                <td>{jobTypes.find((t) => t.key === r.jobTypeKey)?.label ?? r.jobTypeKey}{r.jobTypeRaw && !r.jobTypeMatched ? <span className="l2">from “{r.jobTypeRaw}”</span> : null}</td>
                <td className="n">{r.contractCents === null ? '—' : money(r.contractCents)}</td>
                <td className="tnum">{r.startDate ?? '—'}</td>
                <td>{r.statusRaw ?? '—'}</td>
                <td className="issue">{r.issues.join('. ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <div className="ob-card-b"><InlineNotice tone="neg" title={error} /></div>}
      <div className="ob-card-f">
        <span>
          {toCreate.length} ready{finished > 0 && !includeFinished ? ` · ${finished} finished or cancelled left out` : ''}{invalid > 0 ? ` · ${invalid} can't come in (no name or a repeat)` : ''}
        </span>
        <span className="sp" />
        {finished > 0 && (
          <Check label={`Also bring the ${finished} finished`} checked={includeFinished} onChange={(e) => setIncludeFinished(e.currentTarget.checked)} />
        )}
        <Button variant="primary" disabled={toCreate.length === 0 || progress !== null || !mapping.name} onClick={commit}>
          {progress ? `Created ${progress.done} of ${progress.total}…` : `Bring in ${toCreate.length} ${toCreate.length === 1 ? 'job' : 'jobs'}`}
        </Button>
      </div>
    </section>
  );
}
