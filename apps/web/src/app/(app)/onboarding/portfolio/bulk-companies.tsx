'use client';

import { useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardPaste, FileUp, Loader2, Trash2, XCircle } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';
import { api } from '@/lib/api-client';
import { parseCompanyList } from '@/lib/companies/portfolio/bulk-parse';
import { SHORT_CODE_RE, companyNameKey, deriveShortCode, normalizeShortCode } from '@/lib/companies/short-code';
import type { BulkCreateResponse } from '@/lib/companies/portfolio/types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_ROWS = 250;

interface Draft {
  key: string;
  include: boolean;
  name: string;
  shortCode: string;
  codeEdited: boolean;
  industry: string;
  fiscalYearStartMonth: number;
  result: { ok: boolean; message: string } | null;
}

interface Props {
  existing: Array<{ id: string; name: string; shortCode: string }>;
  existingLoading: boolean;
  onCreated: () => void;
  onNext: () => void;
}

let keySeq = 0;
const nextKey = () => `d${++keySeq}`;

export function BulkCompanies({ existing, existingLoading, onCreated, onNext }: Props) {
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [bulkIndustry, setBulkIndustry] = useState('');
  const [bulkFy, setBulkFy] = useState<number>(1);
  const [creating, setCreating] = useState(false);
  const [summary, setSummary] = useState<{ created: number; failed: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const existingNames = useMemo(() => new Set(existing.map((e) => companyNameKey(e.name))), [existing]);
  const existingCodes = useMemo(() => new Set(existing.map((e) => e.shortCode.toUpperCase())), [existing]);

  /** Re-derive every auto (un-edited) code so the batch stays unique against itself + existing. */
  const recode = (list: Draft[]): Draft[] => {
    const taken = new Set(existingCodes);
    for (const d of list) if (d.codeEdited && d.shortCode) taken.add(d.shortCode);
    return list.map((d) => {
      if (d.codeEdited || d.result?.ok) return d;
      const code = deriveShortCode(d.name, taken);
      taken.add(code);
      return { ...d, shortCode: code };
    });
  };

  const loadText = (raw: string) => {
    const parsed = parseCompanyList(raw);
    const capped = parsed.rows.slice(0, MAX_ROWS);
    const w = [...parsed.warnings];
    if (parsed.rows.length > MAX_ROWS) w.push(`Only the first ${MAX_ROWS} companies are loaded — add the rest in a second batch.`);
    const list: Draft[] = capped.map((r) => {
      const typed = r.shortCode ? normalizeShortCode(r.shortCode) : '';
      return {
        key: nextKey(),
        include: !existingNames.has(companyNameKey(r.name)),
        name: r.name,
        shortCode: typed,
        codeEdited: !!typed,
        industry: r.industry ?? '',
        fiscalYearStartMonth: r.fiscalYearStartMonth ?? 1,
        result: null,
      };
    });
    setDrafts(recode(list));
    setWarnings(w);
    setSummary(null);
    if (list.length === 0) addToast('info', 'No company names found — put one company on each line.');
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1024 * 1024) { addToast('error', 'That file is over 1 MB — is it the right one?'); return; }
    const t = await f.text();
    setText(t);
    loadText(t);
  };

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((ds) => {
      const next = ds.map((d) => (d.key === key ? { ...d, ...patch } : d));
      return patch.name !== undefined || patch.shortCode !== undefined || patch.codeEdited !== undefined ? recode(next) : next;
    });

  const remove = (key: string) => setDrafts((ds) => recode(ds.filter((d) => d.key !== key)));

  const applyToAll = (what: 'industry' | 'fy') =>
    setDrafts((ds) => ds.map((d) => (d.result?.ok ? d : what === 'industry' ? { ...d, industry: bulkIndustry } : { ...d, fiscalYearStartMonth: bulkFy })));

  /** Per-row problems that block creating it. */
  const problems = useMemo(() => {
    const out = new Map<string, string>();
    const codeCount = new Map<string, number>();
    const nameCount = new Map<string, number>();
    for (const d of drafts) {
      if (!d.include || d.result?.ok) continue;
      codeCount.set(d.shortCode, (codeCount.get(d.shortCode) ?? 0) + 1);
      nameCount.set(companyNameKey(d.name), (nameCount.get(companyNameKey(d.name)) ?? 0) + 1);
    }
    for (const d of drafts) {
      if (!d.include || d.result?.ok) continue;
      if (!d.name.trim()) out.set(d.key, 'Name is required');
      else if (existingNames.has(companyNameKey(d.name))) out.set(d.key, 'Already exists');
      else if ((nameCount.get(companyNameKey(d.name)) ?? 0) > 1) out.set(d.key, 'Listed twice');
      else if (!SHORT_CODE_RE.test(d.shortCode)) out.set(d.key, 'Code: 1–10 letters/numbers');
      else if (existingCodes.has(d.shortCode)) out.set(d.key, `Code ${d.shortCode} is taken`);
      else if ((codeCount.get(d.shortCode) ?? 0) > 1) out.set(d.key, `Code ${d.shortCode} used twice`);
    }
    return out;
  }, [drafts, existingNames, existingCodes]);

  const toCreate = drafts.filter((d) => d.include && !d.result?.ok);
  const blocked = toCreate.filter((d) => problems.has(d.key)).length;

  const create = async () => {
    const batch = toCreate.filter((d) => !problems.has(d.key));
    if (batch.length === 0) return;
    setCreating(true);
    const res = await api.post<BulkCreateResponse>('/api/onboarding/portfolio/companies', {
      companies: batch.map((d) => ({
        name: d.name.trim(),
        shortCode: d.shortCode,
        industry: d.industry.trim() || null,
        fiscalYearStartMonth: d.fiscalYearStartMonth,
      })),
    });
    setCreating(false);
    if (!res.data) {
      addToast('error', res.error?.error ?? 'Could not create the companies');
      return;
    }
    const byIndex = new Map(res.data.results.map((r) => [r.index, r]));
    const resultFor = new Map(batch.map((d, i) => [d.key, byIndex.get(i)]));
    setDrafts((ds) =>
      ds.map((d) => {
        const r = resultFor.get(d.key);
        if (!r) return d;
        return r.ok
          ? { ...d, shortCode: r.shortCode ?? d.shortCode, result: { ok: true, message: `Created · ${r.periodsCreated ?? 0} periods` } }
          : { ...d, result: { ok: false, message: r.error ?? 'Failed' } };
      }),
    );
    setSummary({ created: res.data.created, failed: res.data.failed });
    if (res.data.created > 0) {
      addToast('success', `Created ${res.data.created} ${res.data.created === 1 ? 'company' : 'companies'}`);
      onCreated();
    }
    if (res.data.failed > 0) addToast('error', `${res.data.failed} could not be created — see the list`);
  };

  return (
    <div className="space-y-4">
      {/* Input */}
      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Your companies</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Paste one company per line, paste cells from a spreadsheet, or upload a CSV with a <span className="font-mono">name</span> column
              (optional <span className="font-mono">industry</span> and <span className="font-mono">fiscal year start</span>). We’ll suggest a short code for each.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
              <FileUp size={13} aria-hidden /> Upload CSV
            </button>
          </div>
        </div>
        <label htmlFor="company-list" className="sr-only">Company list</label>
        <textarea
          id="company-list"
          className="input font-mono text-xs min-h-[120px]"
          placeholder={'Swan Creek Construction\nIowa Custom Cabinetry\nHeartland HVAC'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={() => loadText(text)} disabled={!text.trim() || existingLoading}>
            <ClipboardPaste size={13} aria-hidden /> Preview companies
          </button>
          {existingLoading && <span className="text-2xs text-slate-500">Checking your existing companies…</span>}
        </div>
        {warnings.length > 0 && (
          <ul className="text-2xs text-amber-400 space-y-0.5" aria-live="polite">
            {warnings.slice(0, 8).map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </div>

      {drafts.length > 0 && (
        <>
          {/* Bulk apply */}
          <div className="card p-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="bulk-industry" className="block text-2xs text-slate-500 mb-1">Industry for all</label>
              <div className="flex gap-1">
                <input id="bulk-industry" className="input py-1.5 w-48" value={bulkIndustry} onChange={(e) => setBulkIndustry(e.target.value)} placeholder="e.g. Construction" maxLength={100} />
                <button type="button" className="btn-secondary btn-sm" onClick={() => applyToAll('industry')}>Apply</button>
              </div>
            </div>
            <div>
              <label htmlFor="bulk-fy" className="block text-2xs text-slate-500 mb-1">Fiscal year starts in</label>
              <div className="flex gap-1">
                <select id="bulk-fy" className="input py-1.5 w-40" value={bulkFy} onChange={(e) => setBulkFy(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <button type="button" className="btn-secondary btn-sm" onClick={() => applyToAll('fy')}>Apply</button>
              </div>
            </div>
            <p className="text-2xs text-slate-500 max-w-xs">
              Most companies’ fiscal year starts in January. Each company gets accounting periods for last year, this year and next year — none are locked.
            </p>
          </div>

          {/* Preview */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Companies to create</caption>
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="px-3 py-2.5 w-10"><span className="sr-only">Include</span></th>
                  <th className="px-3 py-2.5 font-medium">Company name</th>
                  <th className="px-3 py-2.5 font-medium w-32">Short code</th>
                  <th className="px-3 py-2.5 font-medium">Industry</th>
                  <th className="px-3 py-2.5 font-medium w-40">Fiscal year starts</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 w-10"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const done = d.result?.ok === true;
                  const problem = problems.get(d.key);
                  return (
                    <tr key={d.key} className={clsx('border-b border-slate-800/60 last:border-0', !d.include && !done && 'opacity-50')}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="accent-emerald-500"
                          aria-label={`Include ${d.name}`}
                          checked={d.include || done}
                          disabled={done}
                          onChange={(e) => update(d.key, { include: e.target.checked })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input className="input py-1 text-sm" aria-label="Company name" value={d.name} disabled={done} maxLength={200}
                          onChange={(e) => update(d.key, { name: e.target.value })} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className={clsx('input py-1 font-mono text-xs uppercase', problem?.startsWith('Code') && 'border-red-500')}
                          aria-label={`Short code for ${d.name}`}
                          value={d.shortCode}
                          disabled={done}
                          maxLength={10}
                          onChange={(e) => {
                            const v = normalizeShortCode(e.target.value);
                            update(d.key, { shortCode: v, codeEdited: v !== '' });
                          }}
                        />
                        {!d.codeEdited && !done && <span className="text-2xs text-slate-500">suggested</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input className="input py-1 text-sm" aria-label={`Industry for ${d.name}`} value={d.industry} disabled={done} maxLength={100}
                          onChange={(e) => update(d.key, { industry: e.target.value })} />
                      </td>
                      <td className="px-3 py-2">
                        <select className="input py-1 text-sm" aria-label={`Fiscal year start for ${d.name}`} value={d.fiscalYearStartMonth} disabled={done}
                          onChange={(e) => update(d.key, { fiscalYearStartMonth: Number(e.target.value) })}>
                          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {done && <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 size={13} aria-hidden />{d.result?.message}</span>}
                        {d.result && !d.result.ok && <span className="inline-flex items-center gap-1 text-red-400"><XCircle size={13} aria-hidden />{d.result.message}</span>}
                        {!d.result && d.include && problem && <span className="inline-flex items-center gap-1 text-amber-400"><AlertTriangle size={13} aria-hidden />{problem}</span>}
                        {!d.result && d.include && !problem && <span className="text-slate-500">Ready</span>}
                        {!d.result && !d.include && <span className="text-slate-500">Skipped</span>}
                      </td>
                      <td className="px-3 py-2">
                        {!done && (
                          <button type="button" className="btn-ghost btn-sm px-2" aria-label={`Remove ${d.name}`} onClick={() => remove(d.key)}>
                            <Trash2 size={13} aria-hidden />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" onClick={() => void create()} disabled={creating || toCreate.length - blocked === 0}>
              {creating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
              {creating ? 'Creating…' : `Create ${toCreate.length - blocked} ${toCreate.length - blocked === 1 ? 'company' : 'companies'}`}
            </button>
            {blocked > 0 && <span className="text-xs text-amber-400">{blocked} need a fix first (or untick them)</span>}
            {summary && summary.created > 0 && (
              <button type="button" className="btn-secondary ml-auto" onClick={onNext}>
                Next: drop their trial balances <ArrowRight size={14} aria-hidden />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
