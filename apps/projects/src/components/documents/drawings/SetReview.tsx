'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, InlineNotice, Input, Status, api, count, toast } from '@meritbooks/merit-ui';
import type { DrawingRevisionRow, DrawingSetRow } from '@/lib/documents/types';
import { useShell } from '@/components/shell/ShellContext';

type Rev = DrawingRevisionRow & { sheet_number: string; discipline: string | null };

/** Check every page's sheet number / title / revision, then publish the set. */
export function SetReview({ set, revisions, canEdit }: { set: DrawingSetRow; revisions: Rev[]; canEdit: boolean }) {
  const router = useRouter();
  const { readOnly } = useShell();
  const [edits, setEdits] = useState<Record<string, { sheetNumber?: string; title?: string; revisionLabel?: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const editable = canEdit && !readOnly;
  const low = revisions.filter((r) => r.extraction === 'none' || (r.extraction === 'text' && (r.confidence ?? 0) < 0.6));

  const save = async (r: Rev) => {
    const e = edits[r.id];
    if (!e) return;
    setBusy(r.id);
    const res = await api.patch(`/api/documents/drawings/revisions/${r.id}`, { sheetNumber: e.sheetNumber?.trim() || undefined, title: e.title !== undefined ? e.title.trim() || null : undefined, revisionLabel: e.revisionLabel !== undefined ? e.revisionLabel.trim() || null : undefined });
    setBusy(null);
    if (res.error) { toast.error(res.error.error); return; }
    toast(`Saved ${e.sheetNumber ?? r.sheet_number}`);
    setEdits((x) => { const n = { ...x }; delete n[r.id]; return n; });
    router.refresh();
  };

  return (
    <div className="stack">
      <div className="btn-row">
        <Status kind={set.status === 'published' ? 'ready' : 'track'} pip={set.status === 'published' ? 'closed' : 'open'}>{set.status === 'published' ? 'Published' : 'In review'}</Status>
        <span className="t-cap">{count(revisions.length)} sheets</span>
        <span className="sp" style={{ flex: 1 }} />
        <Link className="btn btn--quiet" href={`/documents/drawings?job=${set.job_id}`}>All drawings</Link>
        {editable && set.status === 'review' && <Button variant="primary" onClick={() => setPublishOpen(true)}>Publish set</Button>}
      </div>
      {set.status === 'review' && low.length > 0 && (
        <InlineNotice tone="warn" title={`${count(low.length)} sheets need a look`}>Their numbers came from a placeholder or a weak match in the title block. Fix them before publishing so revisions land on the right sheet.</InlineNotice>
      )}
      <table className="ops-mini dwg-review">
        <thead><tr><th className="n">Page</th><th>Sheet</th><th>Title</th><th>Rev</th><th>Read from</th><th>Current</th><th /></tr></thead>
        <tbody>
          {revisions.map((r) => {
            const e = edits[r.id] ?? {};
            const dirty = !!edits[r.id];
            return (
              <tr key={r.id}>
                <td className="n">{r.page_index + 1}</td>
                <td>{editable ? <Input aria-label={`Sheet number, page ${r.page_index + 1}`} value={e.sheetNumber ?? r.sheet_number} maxLength={40} onChange={(ev) => setEdits((x) => ({ ...x, [r.id]: { ...x[r.id], sheetNumber: ev.target.value.toUpperCase() } }))} /> : <Link href={`/documents/drawings/${r.sheet_id}`}>{r.sheet_number}</Link>}</td>
                <td>{editable ? <Input aria-label={`Title, page ${r.page_index + 1}`} value={e.title ?? r.title ?? ''} maxLength={200} onChange={(ev) => setEdits((x) => ({ ...x, [r.id]: { ...x[r.id], title: ev.target.value } }))} /> : r.title ?? '—'}</td>
                <td>{editable ? <Input aria-label={`Revision, page ${r.page_index + 1}`} value={e.revisionLabel ?? r.revision_label ?? ''} maxLength={20} style={{ width: 60 }} onChange={(ev) => setEdits((x) => ({ ...x, [r.id]: { ...x[r.id], revisionLabel: ev.target.value } }))} /> : r.revision_label ?? '—'}</td>
                <td className="t-cap">{r.extraction === 'manual' ? 'Entered by hand' : r.extraction === 'text' ? `Title block (${Math.round((r.confidence ?? 0) * 100)}%)` : 'Not found'}</td>
                <td>{r.is_current ? <Status kind="ready" pip="closed">Current</Status> : set.status === 'published' ? <span className="t-cap">Superseded</span> : <span className="t-cap">—</span>}</td>
                <td>{dirty ? <Button disabled={busy === r.id} onClick={() => void save(r)}>Save</Button> : <Link href={`/documents/drawings/${r.sheet_id}`}>Open</Link>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ConfirmDialog open={publishOpen} onClose={() => setPublishOpen(false)} title={`Publish ${set.name}`} confirmLabel="Publish set"
        onConfirm={async () => {
          const r = await api.post<{ current: number; superseded: number }>(`/api/documents/drawings/sets/${set.id}`, {});
          if (r.error) throw new Error(r.error.error);
          toast(`Published: ${r.data?.current ?? 0} current${r.data?.superseded ? `, ${r.data.superseded} kept as older revisions` : ''}`);
          router.refresh();
        }}>
        Each sheet in this set becomes the current revision unless a later set already reissued it. Older revisions stay in each sheet&apos;s history.
      </ConfirmDialog>
    </div>
  );
}
