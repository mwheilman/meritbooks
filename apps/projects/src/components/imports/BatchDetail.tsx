'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ButtonLink, ConfirmDialog, InlineNotice, ListPager, Pip, Seg, Tag, WidgetState, count, money, toast, type PipKind } from '@meritbooks/merit-ui';
import { ENTITY_DEFS } from '@/lib/imports/fields';
import type { BatchSummary } from '@/lib/imports/types';
import { getJson, postJson } from './api';
import '../../app/onboarding/onboarding.css';
import './imports.css';

interface Row {
  row_number: number;
  external_ref: string | null;
  validation: 'VALID' | 'WARN' | 'INVALID';
  outcome: string;
  issues: { level: string; message: string }[];
  message: string | null;
  target_table: string | null;
  target_id: string | null;
  data: Record<string, unknown>;
  match: { name?: string; score?: number } | null;
}
interface Detail { batch: BatchSummary & { location_id: string; result: Record<string, unknown> }; rows: Row[]; total: number; offset: number; limit: number }

const OUT: Record<string, [PipKind, string]> = {
  PENDING: ['open', 'Waiting'], CREATED: ['ready', 'Added'], MATCHED: ['ready', 'Matched'], SKIPPED: ['closed', 'Skipped'], ERROR: ['blocked', 'Needs a look'],
  REFERENCE: ['soft', 'History'], ROSTER: ['soft', 'Crew list'], FACT: ['soft', 'Opening balance'],
};
const FILTERS = ['ALL', 'CREATED', 'MATCHED', 'SKIPPED', 'ERROR'] as const;
const PAGE = 50;

function linkFor(r: Row): string | null {
  if (!r.target_id) return null;
  if (r.target_table === 'jobs') return `/jobs/${r.target_id}`;
  if (r.target_table === 'customers') return `/customers/${r.target_id}`;
  return null;
}

/** One import: what each row became (added / matched / skipped / needs a look), with links to the records. */
export function BatchDetail({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (filter !== 'ALL') q.set('outcome', filter);
    const r = await getJson<Detail>(`/api/imports/${batchId}?${q}`);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [batchId, filter, offset]);
  useEffect(() => { void load(); }, [load]);

  const commit = async () => {
    setBusy(true);
    const r = await postJson<{ result: { counts: Record<string, number> } }>(`/api/imports/${batchId}/commit`, {});
    setBusy(false);
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    toast(`Brought in · ${count((r.data.result.counts.CREATED ?? 0) + (r.data.result.counts.MATCHED ?? 0))} rows`);
    void load();
  };
  const undo = async () => {
    setBusy(true);
    const r = await postJson<{ status: string }>(`/api/imports/${batchId}/discard`, {});
    setBusy(false);
    setConfirm(false);
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    toast('Undone. Nothing from this file was brought in.');
    router.push('/setup/imports');
  };

  if (error) return <InlineNotice tone="neg" title={error}><ButtonLink href="/setup/imports">Back to imports</ButtonLink></InlineNotice>;
  if (!data) return <div className="ob-skel" aria-busy="true"><span className="t-cap">Loading the import…</span></div>;
  const b = data.batch;
  const def = ENTITY_DEFS[b.entity];
  const cols = def.fields.slice(0, 4);

  return (
    <div className="ob-stack">
      <div className="imp-head-row">
        <span className="l1">{b.file_name ?? 'File'} · {def.label}</span>
        <Tag>{b.status.toLowerCase()}</Tag>
        <span className="sp" />
        {b.status === 'STAGED' && <Button variant="quiet" icon="undo" disabled={busy} onClick={() => setConfirm(true)}>Undo</Button>}
        {b.status === 'STAGED' && <Button variant="primary" disabled={busy} onClick={commit}>{busy ? 'Bringing in…' : `Bring in ${count(b.valid_count)} rows`}</Button>}
      </div>
      <div className="imp-kpis">
        <span><b className="tnum">{count(b.row_count)}</b> rows</span>
        <span><b className="tnum">{count(b.created_count)}</b> added</span>
        <span><b className="tnum">{count(b.matched_count)}</b> matched to existing</span>
        <span><b className="tnum">{count(b.skipped_count)}</b> skipped</span>
        <span><b className="tnum">{count(b.error_count)}</b> need a look</span>
      </div>
      <Seg aria-label="Show" value={filter} onChange={(v) => { setFilter(v); setOffset(0); }}
        items={FILTERS.map((f) => ({ value: f, label: f === 'ALL' ? 'All' : OUT[f]![1] }))} />
      {data.rows.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'No rows here', body: 'Pick another filter.' }} />
      ) : (
        <div className="ob-tbl">
          <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Rows">
            <thead><tr><th>Row</th><th>Result</th>{cols.map((c) => <th key={c.key}>{c.label}</th>)}<th>Note</th></tr></thead>
            <tbody>
              {data.rows.map((r) => {
                const href = linkFor(r);
                return (
                  <tr key={r.row_number} tabIndex={href ? 0 : undefined} className={href ? 'is-link' : undefined}
                    onClick={href ? () => router.push(href) : undefined} onKeyDown={href ? (e) => { if (e.key === 'Enter') router.push(href); } : undefined}>
                    <td className="tnum">{r.row_number}</td>
                    <td><span className="status"><Pip kind={OUT[r.outcome]?.[0] ?? 'open'} />{OUT[r.outcome]?.[1] ?? r.outcome}</span></td>
                    {cols.map((c) => {
                      const v = r.data[c.key];
                      return <td key={c.key} className={/_cents$/.test(c.key) ? 'num tnum' : undefined}>{v == null ? '—' : typeof v === 'number' && /_cents$/.test(c.key) ? money(v) : String(v)}</td>;
                    })}
                    <td className="issue">{r.message ?? r.issues[0]?.message ?? (r.match?.name ? `Linked to ${r.match.name}` : '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ListPager page={Math.floor(offset / PAGE) + 1} perPage={PAGE} total={data.total} noun="rows" onPage={(p) => setOffset((p - 1) * PAGE)} />
      <ConfirmDialog open={confirm} title="Undo this import?" confirmLabel={`Undo ${b.file_name ?? 'the import'}`} tone="danger" onConfirm={undo} onClose={() => setConfirm(false)}>
        Nothing from {b.file_name ?? 'this file'} was brought in yet. Undoing removes the staged rows; you can drop the file again any time.
      </ConfirmDialog>
    </div>
  );
}
