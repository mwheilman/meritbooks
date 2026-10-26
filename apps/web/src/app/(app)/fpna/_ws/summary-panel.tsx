'use client';

/**
 * "Summarize this view" (AC-W10). The AI writes a DRAFT — a note, never a chat bubble — whose
 * every figure and citation was checked against the computed view on the server. When the AI
 * is paused or the draft is refused, the deterministic sentences are shown instead, plainly.
 */
import { AiPaused, Button, InlineNotice, Note, Tag, api } from '@meritbooks/merit-ui';
import { useState } from 'react';
import s from './fpna.module.css';

interface Bullet {
  text: string;
  citations: string[];
}

type SummaryResponse =
  | { draft: { bullets: Bullet[]; model: string | null; decisionId: string | null }; facts: string[]; deterministic: string[] }
  | { unavailable: true; message: string; deterministic: string[] }
  | { refused: true; problems: string[]; deterministic: string[] };

export function SummaryPanel({ params, onClose }: { params: Record<string, string>; onClose: () => void }) {
  const [res, setRes] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFacts, setShowFacts] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await api.post<SummaryResponse>('/api/fpna/workspace/summarize', params);
    setBusy(false);
    if (r.error || !r.data) {
      setError(r.error?.error ?? 'The summary could not be prepared.');
      return;
    }
    setRes(r.data);
  };

  if (!res && !busy && !error) {
    return (
      <div className={s.summary}>
        <InlineNotice tone="info" title="Summarize this view">
          A draft written only from the figures on this screen — every number is checked against them before you see it. <Button variant="primary" onClick={() => void run()}>Draft a summary</Button>{' '}
          <Button variant="quiet" onClick={onClose}>Not now</Button>
        </InlineNotice>
      </div>
    );
  }
  return (
    <div className={s.summary} aria-live="polite">
      {busy && <div className={s.skeleton} aria-busy="true" style={{ height: 96 }} />}
      {error && (
        <InlineNotice tone="neg" title="Couldn’t prepare the summary.">
          {error} <Button variant="quiet" onClick={() => void run()}>Try again</Button>
        </InlineNotice>
      )}
      {res && 'draft' in res && (
        <Note
          n={1}
          kind="Summary · draft"
          title="What this view says"
          actions={
            <>
              <Tag>Draft — check before sharing</Tag>
              <Button variant="quiet" onClick={() => setShowFacts((v) => !v)}>{showFacts ? 'Hide' : 'Show'} the facts it used</Button>
              <Button variant="quiet" onClick={() => void run()}>Redraft</Button>
              <Button variant="quiet" onClick={onClose}>Close</Button>
            </>
          }
        >
          <ul className={s.bullets}>
            {res.draft.bullets.map((b, i) => (
              <li key={i}>
                {b.text}
                <span className={s.cite}>{b.citations.join(' ')}</span>
              </li>
            ))}
          </ul>
          {showFacts && (
            <ul className={s.bullets} style={{ color: 'var(--ink-2)' }}>
              {res.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </Note>
      )}
      {res && 'unavailable' in res && (
        <AiPaused title="AI summary paused" action={<Button variant="quiet" onClick={onClose}>Close</Button>}>
          {res.message} Here is what the figures say, computed directly:
          <ul className={s.bullets}>
            {res.deterministic.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </AiPaused>
      )}
      {res && 'refused' in res && (
        <InlineNotice tone="warn" title="The draft quoted figures that aren’t on this screen, so it was not shown.">
          Here is what the figures say, computed directly:
          <ul className={s.bullets}>
            {res.deterministic.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <Button variant="quiet" onClick={() => void run()}>Try another draft</Button> <Button variant="quiet" onClick={onClose}>Close</Button>
        </InlineNotice>
      )}
    </div>
  );
}
