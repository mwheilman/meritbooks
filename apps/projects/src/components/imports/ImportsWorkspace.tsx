'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InlineNotice, Pip, Tag, WidgetState, count, type PipKind } from '@meritbooks/merit-ui';
import { ENTITY_DEFS } from '@/lib/imports/fields';
import { HANDOFF_FOR_ENTITY } from '@/lib/imports/opening';
import type { BatchSummary, OpeningKind } from '@/lib/imports/types';
import { getJson } from './api';
import './imports.css';
import { ImportProgressPill } from './ImportProgressPill';
import { OpeningPanel } from './OpeningPanel';
import { SourcesPanel } from './SourcesPanel';
import type { CatalogResponse } from './types';

const STATUS: Record<BatchSummary['status'], [PipKind, string]> = {
  STAGED: ['open', 'Waiting to bring in'], COMMITTING: ['track', 'Bringing in'], COMMITTED: ['ready', 'Brought in'], DISCARDED: ['closed', 'Undone'], FAILED: ['blocked', 'Failed'],
};

/** Settings → Imports: bring records in from any source, see every import, hand opening balances to Books. */
export function ImportsWorkspace({ companyId, companyName, booksUrl }: { companyId: string; companyName: string; booksUrl: string }) {
  const router = useRouter();
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<CatalogResponse>(`/api/imports?companyId=${companyId}`);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const kinds = [...new Set((data?.batches ?? []).filter((b) => b.status === 'COMMITTED').map((b) => HANDOFF_FOR_ENTITY[b.entity]).filter((k): k is OpeningKind => Boolean(k)))];

  return (
    <div className="ob-stack">
      <div className="imp-head-row"><span className="t-cap">Records for {companyName}. Customers, vendors and contacts are matched to the ones you already have.</span><span className="sp" /><ImportProgressPill /></div>
      <SourcesPanel companyId={companyId} booksUrl={booksUrl} onCommitted={() => void load()} />

      <section className="ob-card" aria-labelledby="imp-hist">
        <div className="ob-card-h"><h3 id="imp-hist">Imports so far</h3><span className="t-cap tnum">{data ? count(data.batches.length) : ''}</span></div>
        {error ? <div className="ob-card-b"><InlineNotice tone="neg" title={error} /></div> : !data ? (
          <div className="ob-skel" aria-busy="true"><span className="t-cap">Loading imports…</span></div>
        ) : data.batches.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'Nothing brought in yet', body: 'Pick a tool above and drop its first export.' }} />
        ) : (
          <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Imports">
            <thead><tr><th>File</th><th>What</th><th>Status</th><th className="num">Added</th><th className="num">Matched</th><th className="num">Skipped</th><th className="num">To look at</th><th>When</th></tr></thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.id} tabIndex={0} className="is-link" onClick={() => router.push(`/setup/imports/${b.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/setup/imports/${b.id}`); }}>
                  <td><span className="l1">{b.file_name ?? 'File'}</span><span className="l2">{b.source_system === 'CSV' ? 'Spreadsheet' : b.source_system.replace('_', ' ').toLowerCase()}</span></td>
                  <td>{ENTITY_DEFS[b.entity].label}</td>
                  <td><span className="status"><Pip kind={STATUS[b.status][0]} />{STATUS[b.status][1]}</span></td>
                  <td className="num tnum">{count(b.created_count)}</td>
                  <td className="num tnum">{count(b.matched_count)}</td>
                  <td className="num tnum">{count(b.skipped_count)}</td>
                  <td className="num tnum">{b.error_count ? <Tag tone="warn">{count(b.error_count)}</Tag> : '0'}</td>
                  <td className="tnum">{new Date(b.committed_at ?? b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {kinds.map((k) => <OpeningPanel key={k} companyId={companyId} kind={k} booksUrl={booksUrl} />)}
    </div>
  );
}
