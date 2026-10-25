'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineNotice, Input, Select, WidgetState, api, toast } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import type { TemplateKey } from '@/lib/templates/types';
import { JobSelect } from '@/components/ops/common/bits';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { SendForSignature } from '@/components/esign/SendForSignature';

export interface TemplateOption { key: TemplateKey; label: string; source: { table: string; label: string }; allowed: boolean; signable: boolean }

interface Source { id: string; label: string; detail: string | null }
interface Generated { fileId: string; versionNo: number; title: string; pageCount: number; anchors: number; newDocument: boolean }

/** Pick a template and the record it documents → a branded PDF filed on the job, ready to send for signature. */
export function TemplateGenerator({ templates, jobs, jobId: initialJob, companyId }: { templates: TemplateOption[]; jobs: JobOption[]; jobId: string | null; companyId: string | null }) {
  const v = useVocab();
  const { readOnly } = useShell();
  const [key, setKey] = useState<TemplateKey>(templates.find((t) => t.allowed)?.key ?? 'daily_report');
  const [jobId, setJobId] = useState(initialJob ?? '');
  const [sources, setSources] = useState<Source[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [signers, setSigners] = useState('');
  const [waiverType, setWaiverType] = useState('');
  const [through, setThrough] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Generated | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const t = templates.find((x) => x.key === key)!;
  const company = jobs.find((j) => j.id === jobId)?.companyId ?? companyId;

  useEffect(() => {
    setSources(null);
    setSourceId('');
    const needsJob = key !== 'buyers_order';
    if (needsJob && !jobId) { setSources([]); return; }
    let live = true;
    void api.get<{ sources: Source[] }>('/api/documents/templates/sources', { template: key, jobId: jobId || undefined, companyId: company ?? undefined }).then((r) => {
      if (!live) return;
      setSources(r.data?.sources ?? []);
      if (r.error) setError(r.error.error);
    });
    return () => { live = false; };
  }, [key, jobId, company]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    const names = signers.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const r = await api.post<Generated>('/api/documents/templates', {
      template: key, sourceId, customerSigners: names.length ? names : undefined,
      waiverType: waiverType || undefined, throughDate: through || undefined, amountCents: amount ? Math.round(Number(amount.replace(/[$,]/g, '')) * 100) : undefined,
    });
    setBusy(false);
    if (r.error || !r.data) { setError(r.error?.error ?? 'Not created.'); return; }
    setDone(r.data);
    toast(r.data.newDocument ? `Created ${r.data.title}` : `Added version ${r.data.versionNo} of ${r.data.title}`);
  };

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="mp-form-2">
        <Field label="Template">
          <Select value={key} onChange={(e) => { setKey(e.target.value as TemplateKey); setDone(null); }}>
            {templates.map((x) => <option key={x.key} value={x.key} disabled={!x.allowed}>{x.label}{x.allowed ? '' : ' (needs access to job dollars)'}</option>)}
          </Select>
        </Field>
        {key !== 'buyers_order' && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={(id) => { setJobId(id); setDone(null); }} /></Field>}
      </div>
      <Field label={t.source.label} help={sources && sources.length === 0 ? `No ${t.source.label.toLowerCase()} records here yet.` : undefined}>
        <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={!sources}>
          <option value="">{sources ? `Pick a ${t.source.label.toLowerCase()}` : 'Loading…'}</option>
          {(sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}{s.detail ? ` · ${s.detail}` : ''}</option>)}
        </Select>
      </Field>
      {(key === 'proposal' || key === 'contract' || key === 'change_order') && (
        <Field label="Who signs for the customer" help="Names, comma separated (both spouses = two signature lines)"><Input value={signers} onChange={(e) => setSigners(e.target.value)} maxLength={300} /></Field>
      )}
      {key === 'lien_waiver' && (
        <div className="mp-form-2">
          <Field label="Waiver">
            <Select value={waiverType} onChange={(e) => setWaiverType(e.target.value)}>
              <option value="">From the record</option>
              <option value="conditional_progress">Conditional · progress</option><option value="unconditional_progress">Unconditional · progress</option>
              <option value="conditional_final">Conditional · final</option><option value="unconditional_final">Unconditional · final</option>
            </Select>
          </Field>
          <Field label="Through"><Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <Field label="Amount" help="Blank = billed to date on the commitment"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
      )}
      {error && <InlineNotice tone="neg" title="Not created.">{error}</InlineNotice>}
      {!readOnly && <div><Button variant="primary" disabled={busy || !sourceId || !t.allowed} onClick={() => void generate()}>{busy ? 'Creating the PDF…' : `Create ${t.label.toLowerCase()}`}</Button></div>}
      {done && (
        <WidgetState state={{ kind: 'done', title: `${done.title} · version ${done.versionNo}`, body: `${done.pageCount} page${done.pageCount === 1 ? '' : 's'}, ${done.anchors} signature line${done.anchors === 1 ? '' : 's'}. Filed in the job's documents.`,
          action: (
            <div className="btn-row">
              <Link className="btn" href={`/documents?job=${jobId}&file=${done.fileId}`}>Open document</Link>
              {t.signable && !readOnly && <Button variant="primary" onClick={() => setSendOpen(true)}>Send for signature</Button>}
            </div>
          ) }} />
      )}
      {done && <SendForSignature open={sendOpen} onClose={() => setSendOpen(false)} fileId={done.fileId} title={done.title} subjectTable={t.source.table} subjectId={sourceId} onSent={() => setDone({ ...done })} />}
    </div>
  );
}
