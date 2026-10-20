'use client';

/**
 * Wizard step 3a — map spreadsheet columns to fields. Auto-suggested from header names
 * (or a saved mapping for this client + source), required fields marked, a live preview
 * of the first rows with plain-English problems, and accepted / rejected counts.
 */

import { useId, useMemo } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Wand2 } from 'lucide-react';
import type { ImportFileKind } from '@/lib/dealer/types';
import { KIND_FIELDS, ROW_NOUN, type TargetField } from '@/lib/dealer/imports/fields';
import { applyMapping, sampleColumns, suggestMapping, unmappedRequired, type ColumnMapping } from '@/lib/dealer/imports/mapping';
import type { ParseMapping } from '@/lib/dealer/imports/protocol';
import { validateRows, type ImportContext } from '@/lib/dealer/imports/targets';
import { Select, Toggle } from '../../_components/forms';
import { Notice } from '../../_components/ui';

const GROUP_LABEL: Record<string, string> = { unit: 'Unit details', floor: 'Floor plan', trade: 'Trade-in', check: 'Checks and alternates' };

export function StepMap({
  kind,
  parse,
  mapping,
  onMapping,
  ctx,
  profileNote,
  saveProfile,
  onSaveProfile,
  checking,
  onBack,
  onContinue,
}: {
  kind: ImportFileKind;
  parse: ParseMapping;
  mapping: ColumnMapping;
  onMapping: (m: ColumnMapping) => void;
  ctx: ImportContext;
  profileNote: string | null;
  saveProfile: boolean;
  onSaveProfile: (v: boolean) => void;
  checking: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const fields = KIND_FIELDS[kind];
  const saveId = useId();
  const samples = useMemo(() => sampleColumns(parse.headers, parse.rows), [parse.headers, parse.rows]);
  const cells = useMemo(() => applyMapping(parse.rows, mapping), [parse.rows, mapping]);
  const check = useMemo(() => validateRows(kind, cells, ctx), [kind, cells, ctx]);
  const missing = unmappedRequired(kind, mapping);
  const headerOptions = parse.headers.map((h) => ({ value: h, label: h }));
  const noun = ROW_NOUN[kind];
  const preview = cells.slice(0, 5);
  const mappedFields = fields.filter((f) => mapping[f.key]);

  const groups = useMemo(() => {
    const g = new Map<string, TargetField[]>();
    for (const f of fields) {
      const k = f.group ?? 'main';
      g.set(k, [...(g.get(k) ?? []), f]);
    }
    return [...g.entries()];
  }, [fields]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
        <span>
          <span className="font-mono text-slate-200">{parse.fileName}</span>
          {parse.sheetName && <> · sheet “{parse.sheetName}”</>} · headers on row <span className="font-mono">{parse.headerRow}</span> ·{' '}
          <span className="font-mono tabular-nums">{parse.totalRows.toLocaleString()}</span> rows
        </span>
        <button type="button" className="btn-ghost btn-sm inline-flex items-center gap-1.5" onClick={() => onMapping(suggestMapping(kind, parse.headers))}>
          <Wand2 size={13} /> Re-suggest from headers
        </button>
      </div>

      {parse.aiNotice && <Notice tone="info">{parse.aiNotice}</Notice>}
      {parse.truncated && (
        <Notice tone="warning">
          Only the first {parse.rows.length.toLocaleString()} of {parse.totalRows.toLocaleString()} rows are read. Split the file and import the rest separately.
        </Notice>
      )}
      {profileNote && <Notice tone="info">{profileNote}</Notice>}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <caption className="sr-only">Column mapping</caption>
          <thead className="bg-surface-950 text-left text-caption uppercase tracking-caps text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Field in Books</th>
              <th scope="col" className="w-64 px-4 py-2 font-medium">Column in your file</th>
              <th scope="col" className="px-4 py-2 font-medium">Sample values</th>
            </tr>
          </thead>
          {groups.map(([group, fs]) => (
            <tbody key={group} className="divide-y divide-slate-800/70 border-t border-slate-800">
              {group !== 'main' && (
                <tr>
                  <th colSpan={3} scope="colgroup" className="bg-surface-950/60 px-4 py-1.5 text-left text-2xs font-medium uppercase tracking-caps text-slate-500">
                    {GROUP_LABEL[group] ?? group}
                  </th>
                </tr>
              )}
              {fs.map((f) => {
                const col = mapping[f.key];
                const miss = f.required && !col;
                return (
                  <tr key={f.key} className={clsx(miss && 'bg-amber-500/[0.03]')}>
                    <td className="px-4 py-2 align-top">
                      <div className="text-slate-200">
                        {f.label}
                        {f.required && <span className="ml-0.5 text-red-400" aria-label="required">*</span>}
                      </div>
                      {f.hint && <div className="text-xs text-slate-500">{f.hint}</div>}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <Select<string>
                        aria-label={`Column for ${f.label}`}
                        value={col ?? ''}
                        onChange={(v) => onMapping({ ...mapping, [f.key]: v || null })}
                        options={headerOptions}
                        placeholder="— not in this file —"
                        invalid={miss}
                      />
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className="font-mono text-xs text-slate-400">{col ? (samples[col] ?? []).join(' · ') || 'blank' : '—'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>

      <section aria-label="Preview" className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <h3 className="text-subheading text-white">Preview</h3>
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <CheckCircle2 size={14} /> <span className="font-mono tabular-nums">{check.accepted.toLocaleString()}</span> ready
          </span>
          {check.rejected > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-300">
              <AlertTriangle size={14} /> <span className="font-mono tabular-nums">{check.rejected.toLocaleString()}</span> with problems
            </span>
          )}
          {checking && <span className="text-xs text-slate-500">Checking names and serials against Books…</span>}
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-surface-950 text-left text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Row</th>
                {mappedFields.map((f) => (
                  <th key={f.key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{f.label}</th>
                ))}
                <th scope="col" className="px-3 py-2 font-medium">Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {preview.map((c, i) => {
                const r = check.results[i];
                return (
                  <tr key={i}>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500">{parse.rowNumbers[i]}</td>
                    {mappedFields.map((f) => (
                      <td key={f.key} className="max-w-[12rem] truncate px-3 py-1.5 font-mono text-slate-300">{c[f.key] || <span className="text-slate-600">—</span>}</td>
                    ))}
                    <td className="px-3 py-1.5">
                      {r.ok ? <span className="text-emerald-400">Ready</span> : <span className="text-amber-300">{r.errors.join(' ')}</span>}
                    </td>
                  </tr>
                );
              })}
              {preview.length === 0 && (
                <tr>
                  <td colSpan={mappedFields.length + 2} className="px-3 py-6 text-center text-slate-500">The file has no data rows under the header.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
        <label htmlFor={saveId} className="flex items-center gap-2 text-sm text-slate-300">
          <Toggle id={saveId} checked={saveProfile} onChange={onSaveProfile} label="Save this mapping" />
          Save this mapping for this client and source
        </label>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={onBack}>Back</button>
          <button type="button" className="btn-primary btn-sm" disabled={missing.length > 0 || cells.length === 0} onClick={onContinue} title={missing.length ? `Map: ${missing.map((f) => f.label).join(', ')}` : undefined}>
            Review {check.accepted.toLocaleString()} {noun}{check.accepted === 1 ? '' : 's'}
          </button>
        </div>
      </div>
      {missing.length > 0 && (
        <p className="text-right text-xs text-amber-300">Still to map: {missing.map((f) => f.label).join(', ')}.</p>
      )}
    </div>
  );
}
