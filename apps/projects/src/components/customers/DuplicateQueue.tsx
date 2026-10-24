'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Button, ConfirmDialog, InlineNotice, Keybar, QueueTable, Radio, Tag, WidgetState, api, count, pct, shortDate, toast, type QueueColumn,
} from '@meritbooks/merit-ui';
import type { ReviewItem, ReviewPair } from '@/lib/crm/duplicates';
import { KIND_WORDS, MERGE_FIELDS, defaultChoices, differingFields, mergeSummary, type Choices, type PartyRecord } from '@/lib/crm/merge';
import { matchedWords } from '@/lib/parties/match';
import '@/components/crm/crm.css';

/**
 * Customers → Possible duplicates (SHARED-RECORDS §4): the shared queue Merit Books reads too.
 * Pick a pair to compare side by side, choose per field, then merge (with a plain summary of what
 * moves) or mark "Not a duplicate".
 */
export function DuplicateQueue({ reviews, canEdit, readOnly }: { reviews: ReviewItem[]; canEdit: boolean; readOnly: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [list, setList] = useState(reviews);
  useEffect(() => setList(reviews), [reviews]);
  const selected = sp.get('review');
  const open = (id: string | null) => router.replace(id ? `${pathname}?review=${id}` : pathname, { scroll: false });

  const columns: QueueColumn<ReviewItem>[] = [
    { id: 'pair', header: 'Possible duplicate', cell: (r) => <><span className="l1">{r.a?.name ?? 'Record'} and {r.b?.name ?? 'record'}</span><span className="l2">{matchedWords(r.matched)}</span></> },
    { id: 'kind', header: 'Kind', width: 112, cell: (r) => <Tag>{KIND_WORDS[r.kind].one}</Tag> },
    { id: 'score', header: 'Match', numeric: true, width: 88, cell: (r) => pct(r.score, { decimals: 0 }) },
    { id: 'src', header: 'Found by', width: 160, cell: (r) => <span className="l2">{r.source ? r.source.replace(/_/g, ' ') : 'Matching'} · {shortDate(r.createdAt)}</span> },
  ];

  if (!list.length) {
    return <div className="surface"><WidgetState state={{ kind: 'done', title: 'No possible duplicates', body: 'Every create in Projects and Books is matched at the door; pairs that slip through land here.' }} /></div>;
  }
  return (
    <div className="stack">
      <div className="mp-table">
        <QueueTable aria-label="Possible duplicates" columns={columns} rows={list} getRowId={(r) => r.id} openOnClick onOpen={(r) => open(r.id)}
          cursorId={selected} rowState={(r) => ({ attn: r.score >= 0.9 })} />
      </div>
      <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'compare' }]} note={`${count(list.length)} pairs, strongest first`} />
      {selected && (
        <ReviewPanel key={selected} reviewId={selected} canEdit={canEdit && !readOnly} onResolved={(id) => {
          setList((l) => l.filter((r) => r.id !== id));
          open(null);
          router.refresh();
        }} />
      )}
    </div>
  );
}

function ReviewPanel({ reviewId, canEdit, onResolved }: { reviewId: string; canEdit: boolean; onResolved: (id: string) => void }) {
  const [pair, setPair] = useState<ReviewPair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [survivor, setSurvivor] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [confirm, setConfirm] = useState<'merge' | 'dismiss' | null>(null);

  const load = async () => {
    setError(null);
    const r = await api.get<ReviewPair>(`/api/duplicates/${reviewId}`);
    if (r.error || !r.data) return setError(r.error?.error ?? 'That pair didn’t load.');
    setPair(r.data);
    setSurvivor(r.data.suggestedSurvivorId);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  const keep: PartyRecord | null = pair ? (survivor === pair.b.id ? pair.b : pair.a) : null;
  const other: PartyRecord | null = pair ? (survivor === pair.b.id ? pair.a : pair.b) : null;
  useEffect(() => {
    if (pair && keep && other) setChoices(defaultChoices(pair.review.kind, keep, other));
  }, [pair, keep, other]);
  const diff = useMemo(() => (pair ? new Set(differingFields(pair.review.kind, pair.a, pair.b).map((f) => f.key)) : new Set<string>()), [pair]);

  if (error) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'That pair didn’t load', body: error, onRetry: () => void load(), retryLabel: 'Try again' }} /></div>;
  if (!pair || !keep || !other) return <div className="surface"><WidgetState state={{ kind: 'loading', label: 'Loading both records…' }} /></div>;
  const kind = pair.review.kind;
  const w = KIND_WORDS[kind].one;
  const side = (r: PartyRecord) => (r.id === keep.id ? 'survivor' : 'victim');

  const run = async (op: 'merge' | 'dismiss') => {
    const r = await api.post<{ ok: true; moved?: number }>(`/api/duplicates/${reviewId}`, op === 'merge' ? { op, survivorId: keep.id, fields: choices } : { op });
    if (r.error) {
      toast.error(r.error.error);
      return;
    }
    toast(op === 'merge' ? `Merged into ${keep.name}${r.data?.moved ? ` · ${count(r.data.moved)} records moved` : ''}` : 'Marked not a duplicate');
    setConfirm(null);
    onResolved(reviewId);
  };

  return (
    <section className="crm-box" aria-labelledby="dup-h">
      <div className="crm-box-h"><h2 id="dup-h">Compare {pair.a.name} and {pair.b.name}</h2><span className="sp" /><span className="t-cap">{matchedWords(pair.review.matched)} · {pct(pair.review.score, { decimals: 0 })} match</span></div>
      <div className="crm-box-b stack">
        <div className="dup-grid" role="table" aria-label="Both records">
          <div className="h" role="columnheader">Keep</div>
          {[pair.a, pair.b].map((r) => (
            <div key={r.id} className="h" role="columnheader">
              <Radio name="dup-keep" checked={keep.id === r.id} disabled={!canEdit} onChange={() => setSurvivor(r.id)}
                label={<span className="crm-door-opt"><span className="l1">{r.name}</span><span className="l2">Added {r.createdAt ? shortDate(r.createdAt) : '—'}{r.id === pair.suggestedSurvivorId ? ' · suggested to keep' : ''}</span></span>} />
            </div>
          ))}
          {MERGE_FIELDS[kind].map((f) => (
            <FieldRow key={f.key} label={f.label} a={pair.a} b={pair.b} k={f.key} differs={diff.has(f.key)} chosen={choices[f.key] === 'victim' ? other.id : keep.id}
              disabled={!canEdit} onChoose={(id) => setChoices((c) => ({ ...c, [f.key]: side(id === pair.a.id ? pair.a : pair.b) }))} />
          ))}
          <div className="f" role="rowheader">In Merit Projects</div>
          {[pair.a, pair.b].map((r) => {
            const m = pair.moves[r.id] ?? {};
            const n = Object.values(m).reduce<number>((s, x) => s + (x ?? 0), 0);
            return <div key={r.id} role="cell" className="l2">{n ? `${count(n)} linked records` : 'Nothing linked'}</div>;
          })}
        </div>
        <InlineNotice tone="default" title="What happens on merge">
          <ul className="dup-moves">
            {mergeSummary(kind, keep, other, pair.moves[other.id] ?? {}).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </InlineNotice>
        <p className="t-cap">Terms, credit limits and tax settings stay with Merit Books. When the two records disagree on those, Merit Books settles them; the merge waits until it does.</p>
        {canEdit ? (
          <div className="btn-row">
            <Button variant="primary" onClick={() => setConfirm('merge')}>Merge into {keep.name}</Button>
            <Button onClick={() => setConfirm('dismiss')}>Not a duplicate</Button>
          </div>
        ) : (
          <p className="t-cap">Ask someone who edits customers to resolve this pair.</p>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'merge'}
        onClose={() => setConfirm(null)}
        onConfirm={() => run('merge')}
        title={`Merge ${other.name} into ${keep.name}?`}
        confirmLabel="Merge"
        tone="danger"
        footNote={`The ${w} record ${other.name} is archived; links to it open ${keep.name}.`}
      >
        <ul className="dup-moves">{mergeSummary(kind, keep, other, pair.moves[other.id] ?? {}).map((line) => <li key={line}>{line}</li>)}</ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'dismiss'}
        onClose={() => setConfirm(null)}
        onConfirm={() => run('dismiss')}
        title="Not a duplicate?"
        confirmLabel="Not a duplicate"
      >
        <p className="t-body">{pair.a.name} and {pair.b.name} stay separate, and this pair is never suggested again.</p>
      </ConfirmDialog>
    </section>
  );
}

function FieldRow({ label, a, b, k, differs, chosen, disabled, onChoose }: { label: string; a: PartyRecord; b: PartyRecord; k: string; differs: boolean; chosen: string; disabled: boolean; onChoose: (id: string) => void }) {
  return (
    <>
      <div className="f" role="rowheader">{label}</div>
      {[a, b].map((r) => (
        <div key={r.id} role="cell" className={differs ? undefined : 'same'}>
          {differs ? (
            <Radio name={`dup-f-${k}`} checked={chosen === r.id} disabled={disabled} onChange={() => onChoose(r.id)} label={r.fields[k] || <span className="l2">Empty</span>} aria-label={`${label}: ${r.fields[k] || 'empty'}`} />
          ) : (
            r.fields[k] || <span className="l2">Empty</span>
          )}
        </div>
      ))}
    </>
  );
}
