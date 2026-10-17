'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, ChevronRight, FileSpreadsheet, Loader2, Plus, Trash2, UploadCloud, XCircle } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { ConfidenceBar } from '@/components/ui';
import { addToast } from '@/hooks/use-toast';
import { api } from '@/lib/api-client';
import { defaultCutoverDate } from '@/lib/companies/fiscal-periods';
import { matchTbToCompany, suggestedCompanyName, type CompanyMatch } from '@/lib/companies/portfolio/company-match';
import type { BulkCreateResponse, TbReadResponse } from '@/lib/companies/portfolio/types';

const SHEET_EXT = ['csv', 'tsv', 'txt', 'xlsx'];
const AI_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const ACCEPT = [...SHEET_EXT, ...AI_EXT].map((e) => `.${e}`).join(',');
const READ_CONCURRENCY = 3;
const MAX_FILES = 100;

interface Company { id: string; name: string; shortCode: string; sessionCount: number }

interface ParsedTb {
  titleLines: string[];
  detectedAsOf: string | null;
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  excludedCount: number;
}

type ItemStatus = 'queued' | 'reading' | 'ready' | 'error' | 'creating' | 'created' | 'failed';

interface Item {
  key: string;
  file: File;
  status: ItemStatus;
  error: string | null;
  parsed: ParsedTb | null;
  match: CompanyMatch | null;
  companyId: string;
  manual: boolean;
  sessionId: string | null;
}

interface Props {
  companies: Company[];
  companiesLoading: boolean;
  onCompaniesChanged: () => Promise<void>;
  onSessionsCreated: () => void;
  onDone: () => void;
}

/** Shape returned by the existing AI reader for PDFs/images (`/api/onboarding/import/tb`). */
interface AiTbResponse {
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  tieOut: { balanced: boolean; totalDebitCents: number; totalCreditCents: number };
  dropped?: unknown[];
  documentNote?: string | null;
}

let seq = 0;
const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function dayAfter(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function readFile(file: File): Promise<{ ok: true; parsed: ParsedTb } | { ok: false; error: string }> {
  const e = ext(file.name);
  const form = new FormData();
  form.append('file', file);
  if (SHEET_EXT.includes(e)) {
    const res = await fetch('/api/onboarding/portfolio/tb', { method: 'POST', body: form }).catch(() => null);
    if (!res) return { ok: false, error: 'Could not reach the server' };
    const body = (await res.json().catch(() => ({}))) as Partial<TbReadResponse> & { error?: string };
    if (!res.ok || !body.rows) return { ok: false, error: body.error ?? 'Could not read this file' };
    return {
      ok: true,
      parsed: {
        titleLines: body.titleLines ?? [],
        detectedAsOf: body.detectedAsOf ?? null,
        mapping: body.mapping ?? {},
        rows: body.rows,
        totalDebitCents: body.totalDebitCents ?? 0,
        totalCreditCents: body.totalCreditCents ?? 0,
        balanced: body.balanced ?? false,
        excludedCount: body.excludedCount ?? 0,
      },
    };
  }
  if (AI_EXT.includes(e)) {
    const res = await fetch('/api/onboarding/import/tb', { method: 'POST', body: form }).catch(() => null);
    if (!res) return { ok: false, error: 'Could not reach the server' };
    const body = (await res.json().catch(() => ({}))) as Partial<AiTbResponse> & { error?: string; code?: string };
    if (!res.ok || !body.rows || !body.mapping) {
      const aiDown = body.code === 'NO_API_KEY' || body.code === 'BUDGET_BLOCKED';
      return { ok: false, error: aiDown ? 'Reading PDFs needs AI, which is unavailable — export the Trial Balance to Excel or CSV instead.' : body.error ?? 'Could not read this document' };
    }
    return {
      ok: true,
      parsed: {
        titleLines: body.documentNote ? [body.documentNote] : [],
        detectedAsOf: null,
        mapping: body.mapping,
        rows: body.rows,
        totalDebitCents: body.tieOut?.totalDebitCents ?? 0,
        totalCreditCents: body.tieOut?.totalCreditCents ?? 0,
        balanced: body.tieOut?.balanced ?? false,
        excludedCount: Array.isArray(body.dropped) ? body.dropped.length : 0,
      },
    };
  }
  return { ok: false, error: `.${e} isn’t a trial-balance format — use Excel (.xlsx), CSV or PDF` };
}

export function TbDrop({ companies, companiesLoading, onCompaniesChanged, onSessionsCreated, onDone }: Props) {
  const [cutover, setCutover] = useState(() => defaultCutoverDate(new Date()));
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const companiesRef = useRef(companies);
  companiesRef.current = companies;

  const patch = useCallback((key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x))), []);

  const matchFor = (file: File, parsed: ParsedTb | null): CompanyMatch =>
    matchTbToCompany({ fileName: file.name, titleLines: parsed?.titleLines ?? [] }, companiesRef.current);

  // Re-match automatically-matched files when the company list changes (e.g. after adding one).
  useEffect(() => {
    setItems((xs) => xs.map((x) => {
      if (x.manual || !x.parsed || x.status !== 'ready') return x;
      const m = matchTbToCompany({ fileName: x.file.name, titleLines: x.parsed.titleLines }, companies);
      return { ...x, match: m, companyId: m.companyId ?? '' };
    }));
  }, [companies]);

  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list).slice(0, Math.max(0, MAX_FILES - items.length));
    if (incoming.length === 0) return;
    const fresh: Item[] = incoming.map((file) => ({
      key: `f${++seq}`, file, status: 'queued', error: null, parsed: null, match: null, companyId: '', manual: false, sessionId: null,
    }));
    setItems((xs) => [...xs, ...fresh]);
    // Small worker pool so a 17-file drop reads quickly without flooding the server.
    const queue = [...fresh];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        patch(it.key, { status: 'reading' });
        const r = await readFile(it.file);
        if (r.ok) {
          const m = matchFor(it.file, r.parsed);
          patch(it.key, { status: 'ready', parsed: r.parsed, match: m, companyId: m.companyId ?? '' });
        } else {
          patch(it.key, { status: 'error', error: r.error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, fresh.length) }, worker));
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  };

  const createCompanyFor = async (item: Item, name: string) => {
    setCreatingFor(item.key);
    const res = await api.post<BulkCreateResponse>('/api/onboarding/portfolio/companies', { companies: [{ name }] });
    setCreatingFor(null);
    const r = res.data?.results[0];
    if (!r?.ok || !r.locationId) {
      addToast('error', r?.error ?? res.error?.error ?? 'Could not create the company');
      return;
    }
    addToast('success', `Created ${name} (${r.shortCode})`);
    patch(item.key, { companyId: r.locationId, manual: true });
    await onCompaniesChanged();
  };

  // Validation across files.
  const assigned = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of items) if (x.companyId && x.status !== 'created') m.set(x.companyId, (m.get(x.companyId) ?? 0) + 1);
    return m;
  }, [items]);
  const ready = items.filter((x) => (x.status === 'ready' || x.status === 'failed') && x.parsed && x.companyId && (assigned.get(x.companyId) ?? 0) === 1);
  const dupes = items.filter((x) => x.companyId && (assigned.get(x.companyId) ?? 0) > 1 && x.status !== 'created').length;
  const unmatched = items.filter((x) => x.status === 'ready' && !x.companyId).length;
  const reading = items.some((x) => x.status === 'queued' || x.status === 'reading');

  // If every file prints the same "as of" date and it differs from the takeover date, offer it.
  const fileDates = Array.from(new Set(items.map((x) => x.parsed?.detectedAsOf).filter((d): d is string => !!d)));
  const suggestDate = fileDates.length === 1 && fileDates[0] !== cutover ? fileDates[0] : null;

  const start = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutover)) { addToast('error', 'Pick a takeover date first'); return; }
    setRunning(true);
    let ok = 0;
    for (const x of ready) {
      patch(x.key, { status: 'creating', error: null });
      const res = await api.post<{ id: string }>('/api/onboarding/conversion', {
        companyId: x.companyId,
        asOfDate: cutover,
        mapping: x.parsed!.mapping,
        rows: x.parsed!.rows,
      });
      if (res.data?.id) { ok++; patch(x.key, { status: 'created', sessionId: res.data.id }); }
      else patch(x.key, { status: 'failed', error: res.error?.error ?? 'Could not start this conversion' });
    }
    setRunning(false);
    if (ok > 0) {
      addToast('success', `Balances uploaded for ${ok} ${ok === 1 ? 'company' : 'companies'}`);
      onSessionsCreated();
    }
  };

  const nameOf = (id: string) => companies.find((c) => c.id === id);
  const sortedCompanies = useMemo(() => [...companies].sort((a, b) => a.name.localeCompare(b.name)), [companies]);
  const created = items.filter((x) => x.status === 'created').length;

  return (
    <div className="space-y-4">
      {/* Shared takeover date */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="cutover" className="block text-2xs text-slate-500 mb-1">Balances as of (takeover date)</label>
          <input id="cutover" type="date" className="input py-1.5 w-44 font-mono" value={cutover} onChange={(e) => setCutover(e.target.value)} />
        </div>
        <p className="text-sm text-slate-300 flex-1 min-w-[260px]">
          {/^\d{4}-\d{2}-\d{2}$/.test(cutover)
            ? <>MeritBooks takes over on <span className="text-ink-hi font-medium">{dayAfter(cutover)}</span>. Everything before that stays in your old system — we only bring in the ending balances.</>
            : 'Pick the date your trial balances are as of.'}
        </p>
        {suggestDate && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => setCutover(suggestDate)}>
            Your files are as of <span className="font-mono">{fmtDate(suggestDate)}</span> — use that
          </button>
        )}
      </div>

      {/* Drop zone */}
      <div
        role="region"
        aria-label="Trial balance files"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={clsx(
          'rounded-xl border-2 border-dashed p-8 text-center transition-colors',
          dragging ? 'border-brand-500 bg-brand-500/5' : 'border-slate-700 bg-surface-900/50',
        )}
      >
        <UploadCloud size={28} className="mx-auto text-slate-500" aria-hidden />
        <p className="mt-2 text-sm text-slate-200 font-medium">Drop every company’s trial balance here</p>
        <p className="text-xs text-slate-500 mt-1">
          Excel or CSV straight from QuickBooks, Xero or Sage (title rows are fine). PDFs work too when AI is on.
          We match each file to its company by the name in the file.
        </p>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="btn-secondary btn-sm mt-4" onClick={() => inputRef.current?.click()} disabled={companiesLoading}>
          <FileSpreadsheet size={13} aria-hidden /> Choose files
        </button>
        {companiesLoading && <p className="text-2xs text-slate-500 mt-2">Loading your companies…</p>}
        {!companiesLoading && companies.length === 0 && (
          <p className="text-2xs text-amber-400 mt-2">You don’t have any companies yet — you can create them from the files, or add them first.</p>
        )}
      </div>

      {items.length > 0 && (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Dropped trial balances and their companies</caption>
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="px-3 py-2.5 font-medium">File</th>
                  <th className="px-3 py-2.5 font-medium min-w-[260px]">Company</th>
                  <th className="px-3 py-2.5 font-medium text-right">Debits</th>
                  <th className="px-3 py-2.5 font-medium text-right">Credits</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => {
                  const p = x.parsed;
                  const dup = !!x.companyId && (assigned.get(x.companyId) ?? 0) > 1 && x.status !== 'created';
                  const suggestion = p && !x.companyId ? suggestedCompanyName(p.titleLines) : null;
                  const diff = p ? p.totalDebitCents - p.totalCreditCents : 0;
                  const company = x.companyId ? nameOf(x.companyId) : undefined;
                  const locked = x.status === 'creating' || x.status === 'created';
                  return (
                    <tr key={x.key} className="border-b border-slate-800/60 last:border-0 align-top">
                      <td className="px-3 py-2.5">
                        <div className="text-slate-200 break-all">{x.file.name}</div>
                        {p && (
                          <div className="text-2xs text-slate-500 mt-0.5">
                            <span className="font-mono tabular-nums">{p.rows.length}</span> accounts
                            {p.excludedCount > 0 && <> · <span className="font-mono tabular-nums">{p.excludedCount}</span> total/heading lines skipped</>}
                            {p.detectedAsOf && (
                              <> · as of <span className={clsx('font-mono', p.detectedAsOf !== cutover && 'text-amber-400')}>{fmtDate(p.detectedAsOf)}</span></>
                            )}
                          </div>
                        )}
                        {p?.detectedAsOf && p.detectedAsOf !== cutover && (
                          <div className="text-2xs text-amber-400 mt-0.5">File date differs from the takeover date</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {(x.status === 'queued' || x.status === 'reading') && <span className="text-xs text-slate-500">Reading…</span>}
                        {p && (
                          <div className="space-y-1">
                            <select
                              className={clsx('input py-1 text-sm', dup && 'border-amber-500', !x.companyId && 'border-red-500/60')}
                              aria-label={`Company for ${x.file.name}`}
                              value={x.companyId}
                              disabled={locked}
                              onChange={(e) => patch(x.key, { companyId: e.target.value, manual: true })}
                            >
                              <option value="">— Choose company —</option>
                              {sortedCompanies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.shortCode})</option>)}
                            </select>
                            {x.match && !x.manual && x.companyId && (
                              <div title={x.match.reason}>
                                <ConfidenceBar value={x.match.confidence} />
                                <div className="text-2xs text-slate-500">{x.match.reason}</div>
                              </div>
                            )}
                            {dup && <div className="text-2xs text-amber-400">Another file is also set to this company — pick one.</div>}
                            {company && company.sessionCount > 0 && !locked && (
                              <div className="text-2xs text-slate-500">This company already has balances uploaded — this adds a new version.</div>
                            )}
                            {suggestion && !locked && (
                              <button type="button" className="btn-ghost btn-sm px-0 text-emerald-400" disabled={creatingFor === x.key}
                                onClick={() => void createCompanyFor(x, suggestion)}>
                                {creatingFor === x.key ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Plus size={12} aria-hidden />}
                                Add “{suggestion}” as a new company
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{p ? formatMoney(p.totalDebitCents) : '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {p ? formatMoney(p.totalCreditCents) : '—'}
                        {p && diff !== 0 && <div className="text-2xs text-amber-400">Off by {formatMoney(Math.abs(diff))}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {x.status === 'error' && <span className="inline-flex items-start gap-1 text-red-400"><XCircle size={13} className="shrink-0 mt-0.5" aria-hidden />{x.error}</span>}
                        {x.status === 'failed' && <span className="inline-flex items-start gap-1 text-red-400"><XCircle size={13} className="shrink-0 mt-0.5" aria-hidden />{x.error}</span>}
                        {x.status === 'ready' && (x.companyId && !dup ? <span className="text-slate-400">Ready</span> : <span className="text-amber-400">Needs a company</span>)}
                        {x.status === 'creating' && <span className="inline-flex items-center gap-1 text-slate-300"><Loader2 size={13} className="animate-spin" aria-hidden />Matching accounts…</span>}
                        {x.status === 'created' && x.sessionId && (
                          <Link href={`/onboarding/conversion?sessionId=${encodeURIComponent(x.sessionId)}`} className="inline-flex items-center gap-1 text-brand-400 hover:underline">
                            <CheckCircle2 size={13} aria-hidden /> Review <ChevronRight size={12} aria-hidden />
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {!locked && (
                          <button type="button" className="btn-ghost btn-sm px-2" aria-label={`Remove ${x.file.name}`} onClick={() => setItems((xs) => xs.filter((y) => y.key !== x.key))}>
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
            <button type="button" className="btn-primary" onClick={() => void start()} disabled={running || reading || ready.length === 0}>
              {running && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {running ? 'Uploading balances…' : `Upload balances for ${ready.length} ${ready.length === 1 ? 'company' : 'companies'}`}
            </button>
            {(unmatched > 0 || dupes > 0) && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                <AlertTriangle size={13} aria-hidden />
                {unmatched > 0 && `${unmatched} need a company`}
                {unmatched > 0 && dupes > 0 && ' · '}
                {dupes > 0 && `${dupes} share a company`}
              </span>
            )}
            {created > 0 && !running && (
              <button type="button" className="btn-secondary ml-auto" onClick={onDone}>
                See progress in the Control Tower <ChevronRight size={14} aria-hidden />
              </button>
            )}
          </div>
          <p className="text-2xs text-slate-500">
            Uploading creates a review for each company: we suggest how each old account maps to your chart of accounts, then a person checks the
            balances before anything is posted. Nothing posts to the books from this screen.
          </p>
        </>
      )}
    </div>
  );
}
