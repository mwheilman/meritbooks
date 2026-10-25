'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Field, Search, Status, Tag, WidgetState, count, useDebounce } from '@meritbooks/merit-ui';
import { SET_KIND_LABEL, type DrawingSetRow } from '@/lib/documents/types';
import type { SheetListItem } from '@/lib/documents/drawings';
import type { JobOption } from '@/lib/pm/ops/scope';
import { JobSelect } from '@/components/ops/common/bits';
import { useShell } from '@/components/shell/ShellContext';
import { SetUpload } from './SetUpload';
import { day } from '../client';

/** The current set by discipline, every set (review / published), and the upload. */
export function DrawingsView({ jobs, jobId, sets, sheets, canCreate }: { jobs: JobOption[]; jobId: string | null; sets: DrawingSetRow[]; sheets: SheetListItem[]; canCreate: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { readOnly } = useShell();
  const [upload, setUpload] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 150).trim().toLowerCase();
  const groups = useMemo(() => {
    const by = new Map<string, SheetListItem[]>();
    for (const s of sheets) {
      if (dq && !`${s.sheet_number} ${s.title ?? ''}`.toLowerCase().includes(dq)) continue;
      const k = s.discipline ?? 'Other';
      by.set(k, [...(by.get(k) ?? []), s]);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sheets, dq]);
  const review = sets.filter((s) => s.status === 'review');
  const setName = new Map(sets.map((s) => [s.id, s]));

  if (!jobId) {
    return (
      <div className="stack">
        <div className="ops-toolbar"><Field label="Job"><JobSelect jobs={jobs} value="" onChange={(id) => router.push(`${pathname}?job=${id}`)} /></Field></div>
        <WidgetState state={{ kind: 'empty', title: 'Pick a job to see its drawings', body: 'Upload a PDF set; each page becomes a sheet with its revision history.' }} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={(id) => router.push(`${pathname}?job=${id}`)} /></Field>
        <Search aria-label="Find a sheet" placeholder="Sheet number or title" value={q} onChange={(e) => setQ(e.target.value)} slashToFocus />
        <span className="sp" />
        {!readOnly && canCreate && <Button variant="primary" icon="upload" onClick={() => setUpload(true)}>Upload set</Button>}
      </div>
      {review.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-h"><h2 className="t-section">In review</h2><span className="t-cap">Not current until published</span></div>
          <ul className="dwg-marks">
            {review.map((s) => (
              <li key={s.id}><Link href={`/documents/drawings/sets/${s.id}`}>{s.name}</Link><span className="t-cap">{SET_KIND_LABEL[s.set_kind]} · {count(s.sheet_count)} sheets · {s.issued_on ? day(s.issued_on) : 'no date'}</span></li>
            ))}
          </ul>
        </div>
      )}
      <div className="ops-section">
        <div className="ops-section-h"><h2 className="t-section">Current set</h2><span className="t-cap">{count(sheets.filter((s) => s.current).length)} sheets</span></div>
        {sheets.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'No drawings yet', body: 'Upload the PDF set. Sheet numbers and titles are read from the title block; you check them before publishing.', action: !readOnly && canCreate ? <Button variant="primary" onClick={() => setUpload(true)}>Upload set</Button> : undefined }} />
        ) : groups.length === 0 ? (
          <WidgetState state={{ kind: 'done', title: 'No sheet matches', body: 'Clear the search to see every sheet.' }} />
        ) : groups.map(([disc, list]) => (
          <div key={disc} style={{ marginBottom: 16 }}>
            <p className="t-cap" style={{ marginBottom: 8 }}>{disc} · {count(list.length)}</p>
            <div className="dwg-index">
              {list.map((s) => (
                <Link key={s.id} className="dwg-card" href={`/documents/drawings/${s.id}`}>
                  <span className="num">{s.sheet_number}</span>
                  <span style={{ display: 'block' }}>{s.title ?? 'Untitled sheet'}</span>
                  <span className="t-cap" style={{ display: 'block', marginTop: 4 }}>
                    {s.current ? <>{s.current.set_name}{s.current.revision_label ? ` · rev ${s.current.revision_label}` : ''}{s.current.issued_on ? ` · ${day(s.current.issued_on)}` : ''}</> : <Tag tone="warn">Not published</Tag>}
                    {s.revision_count > 1 ? ` · ${s.revision_count} revisions` : ''}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
      {sets.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-h"><h2 className="t-section">Sets</h2></div>
          <table className="ops-mini">
            <thead><tr><th>Set</th><th>Kind</th><th>Issued</th><th className="n">Sheets</th><th>Status</th></tr></thead>
            <tbody>
              {sets.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/documents/drawings/sets/${s.id}`}>{setName.get(s.id)?.name}</Link></td>
                  <td>{SET_KIND_LABEL[s.set_kind]}</td>
                  <td>{s.issued_on ? day(s.issued_on) : '—'}</td>
                  <td className="n">{count(s.sheet_count)}</td>
                  <td><Status kind={s.status === 'published' ? 'ready' : 'track'} pip={s.status === 'published' ? 'closed' : 'open'}>{s.status === 'published' ? 'Published' : 'In review'}</Status></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {upload && <SetUpload open={upload} onClose={() => setUpload(false)} jobId={jobId} />}
    </div>
  );
}
