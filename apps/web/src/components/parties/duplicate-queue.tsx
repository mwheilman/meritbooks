'use client';

/**
 * The duplicate review queue (core.duplicate_reviews — ONE queue for Books and Projects, Projects
 * migration 1111). Pairs the door ("Already in Merit") or the insert safety net filed as possible
 * duplicates. Per pair: Keep A / Keep B (merge — every reference moves to the record kept; Books
 * money settings that differ are refused by the merge with its reason) or Not a duplicate (never
 * suggested again). States: loading, empty, populated, error, matcher not deployed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmDialog, InlineNotice, Tag, toast } from '@meritbooks/merit-ui';

interface Side { id: string; name: string; email: string | null; city: string | null; created_at: string | null }
interface Review {
  id: string;
  kind: 'customer' | 'vendor';
  score: number;
  matched: string[];
  source: string;
  created_at: string;
  suggested_survivor_id: string | null;
  a: Side;
  b: Side;
}

const MATCHED: Record<string, string> = { tax_id: 'same tax ID', email: 'same email', phone: 'same phone', address: 'same address', name: 'similar name' };

function sideLine(s: Side): string {
  return [s.email, s.city, s.created_at ? `added ${s.created_at.slice(0, 10)}` : null].filter(Boolean).join(' · ');
}

export function DuplicateQueue({ kind }: { kind: 'customer' | 'vendor' }) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ review: Review; keep: Side; drop: Side } | null>(null);
  const noun = kind === 'vendor' ? 'vendor' : 'customer';

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/parties/duplicates?kind=${kind}`);
      const body = (await res.json()) as { available?: boolean; reviews?: Review[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not load the review queue');
      setAvailable(body.available !== false);
      setReviews(body.reviews ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the review queue');
      setReviews([]);
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  const act = async (payload: Record<string, unknown>, done: string) => {
    setBusy(String(payload.review_id));
    try {
      const res = await fetch('/api/parties/duplicates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ...payload }) });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Not saved');
      toast(done);
      await load();
    } catch (e) {
      toast.error(`Not saved${e instanceof Error ? ` — ${e.message}` : ''}`);
    } finally {
      setBusy(null);
    }
  };

  if (reviews === null) return <p aria-busy="true">Loading possible duplicates…</p>;
  if (error) return <InlineNotice tone="neg" title="The review queue did not load.">{error} <button type="button" className="link" onClick={() => void load()}>Try again</button></InlineNotice>;
  if (!available) return <InlineNotice title="Duplicate review is not switched on yet.">It arrives with the shared customer records update; nothing is lost in the meantime.</InlineNotice>;
  if (reviews.length === 0) return <InlineNotice title={`No possible duplicate ${noun}s.`}>New {noun}s are checked against everything already in Merit — Books and Projects — before they are created.</InlineNotice>;

  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }} aria-label={`Possible duplicate ${noun}s`}>
        {reviews.map((r) => {
          const keepFirst = r.suggested_survivor_id === r.b.id ? [r.b, r.a] : [r.a, r.b];
          return (
            <li key={r.id} style={{ padding: 16, background: "var(--white)", border: "1px solid var(--line-2)" }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <Tag tone={r.score >= 0.9 ? 'warn' : 'default'}>{Math.round(r.score * 100)}% match</Tag>
                {r.matched.map((m) => <Tag key={m}>{MATCHED[m] ?? m}</Tag>)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {keepFirst.map((s, i) => (
                  <div key={s.id}>
                    <b>{s.name}</b>{i === 0 && r.suggested_survivor_id ? <span style={{ fontSize: 12 }}> · suggested to keep</span> : null}
                    <div style={{ fontSize: 12 }}>{sideLine(s) || '—'}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {keepFirst.map((s, i) => (
                  <Button key={s.id} variant={i === 0 ? 'primary' : 'default'} disabled={busy === r.id}
                    onClick={() => setConfirm({ review: r, keep: s, drop: s.id === r.a.id ? r.b : r.a })}>
                    Keep {s.name}
                  </Button>
                ))}
                <Button variant="quiet" disabled={busy === r.id} onClick={() => void act({ action: 'dismiss', review_id: r.id }, 'Marked as not a duplicate')}>
                  Not a duplicate
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {confirm && (
        <ConfirmDialog
          open
          title={`Merge into ${confirm.keep.name}?`}
          confirmLabel="Merge"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            await act({ action: 'merge', review_id: c.review.id, survivor_id: c.keep.id }, `Merged into ${c.keep.name}`);
            setConfirm(null);
          }}
        >
          Every invoice, bill, job and contact on {confirm.drop.name} moves to {confirm.keep.name}. Posted amounts and dates never change.
          {' '}{confirm.drop.name} stays as an archived record so history still resolves.
        </ConfirmDialog>
      )}
    </>
  );
}
