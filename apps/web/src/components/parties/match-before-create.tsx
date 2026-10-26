'use client';

/**
 * <MatchBeforeCreate> — "Already in Merit" at the door of a new customer / vendor (migration 194
 * slice; Projects 1111 core.match_parties). Self-contained: drop it into any create form and pass
 * what the person has typed so far. It debounces, asks /api/parties/match, and — only when there
 * is a likely match — shows:
 *
 *   Already in Merit: Harbor Holdings — used in Projects since March 2026 · same email
 *   [Use existing]  [Create anyway]   Review possible duplicates →
 *
 * "Use existing" hands the match to the parent (open / select that record instead). "Create
 * anyway" records the decision (onDecision('create_anyway')) — the parent sends create_anyway:
 * true so the create route does not stop it again; the duplicate safety net still files the pair
 * for review. Works for every org, with or without Merit Projects. Never blocks typing; a matcher
 * fault shows a quiet line and the form carries on.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, InlineNotice, Tag, useDebounce } from '@meritbooks/merit-ui';
import type { PartyMatch } from '@/lib/parties/match';

export type MatchDecision = 'create_anyway' | null;

export interface MatchBeforeCreateProps {
  kind: 'customer' | 'vendor';
  name: string;
  email?: string | null;
  phone?: string | null;
  /** Free text, e.g. '12 Oak St, Ames IA 50010'. */
  address?: string | null;
  taxId?: string | null;
  onUseExisting: (match: PartyMatch) => void;
  onDecision?: (decision: MatchDecision) => void;
  /** Where the duplicate review queue lives (default /customers/duplicates or /vendors/duplicates). */
  reviewHref?: string;
  className?: string;
}

type State =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; matches: PartyMatch[] }
  | { phase: 'error' };

const MATCHED_WORDS: Record<string, string> = {
  tax_id: 'same tax ID', email: 'same email', phone: 'same phone', address: 'same address', name: 'similar name',
};

export function matchedWords(matched: readonly string[]): string {
  return matched.map((k) => MATCHED_WORDS[k] ?? k.replace(/_/g, ' ')).join(', ') || 'similar name';
}

export function MatchBeforeCreate({
  kind, name, email, phone, address, taxId, onUseExisting, onDecision, reviewHref, className,
}: MatchBeforeCreateProps) {
  const query = useMemo(
    () => ({ kind, name: name.trim(), email: email?.trim() || null, phone: phone?.trim() || null, address: address?.trim() || null, tax_id: taxId?.trim() || null }),
    [kind, name, email, phone, address, taxId],
  );
  const debounced = useDebounce(query, 400);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const seq = useRef(0);

  const ready = debounced.name.length >= 3 || !!debounced.email || !!debounced.phone || !!debounced.tax_id;
  const key = JSON.stringify(debounced);

  useEffect(() => {
    if (!ready) { setState({ phase: 'idle' }); return; }
    const my = ++seq.current;
    setState({ phase: 'checking' });
    fetch('/api/parties/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...debounced, limit: 3 }) })
      .then(async (res) => {
        if (my !== seq.current) return;
        if (!res.ok) { setState({ phase: 'error' }); return; }
        const body = (await res.json()) as { available: boolean; matches: PartyMatch[] };
        setState({ phase: 'done', matches: body.available ? body.matches : [] });
      })
      .catch(() => { if (my === seq.current) setState({ phase: 'error' }); });
  }, [key, ready, debounced]);

  // A new query re-opens the decision.
  useEffect(() => {
    if (dismissedKey && dismissedKey !== key) { setDismissedKey(null); onDecision?.(null); }
  }, [key, dismissedKey, onDecision]);

  const href = reviewHref ?? (kind === 'vendor' ? '/vendors/duplicates' : '/customers/duplicates');
  const noun = kind === 'vendor' ? 'vendor' : 'customer';

  if (state.phase === 'checking') {
    return <p className={className} aria-live="polite" style={{ fontSize: 12, color: 'var(--steel, #3D4F65)', margin: 0 }}>Checking Merit for an existing {noun}…</p>;
  }
  if (state.phase === 'error') {
    return <p className={className} aria-live="polite" style={{ fontSize: 12, color: 'var(--steel, #3D4F65)', margin: 0 }}>Could not check for an existing {noun} — you can still save.</p>;
  }
  if (state.phase !== 'done' || state.matches.length === 0) return null;

  if (dismissedKey === key) {
    return (
      <p className={className} aria-live="polite" style={{ fontSize: 12, margin: 0 }}>
        Creating a new {noun} anyway.{' '}
        <button type="button" className="link" onClick={() => { setDismissedKey(null); onDecision?.(null); }}>Undo</button>
      </p>
    );
  }

  const [top, ...rest] = state.matches;
  return (
    <div className={className} aria-live="polite">
      <InlineNotice
        tone={top.level === 'exact' ? 'warn' : 'info'}
        title={<>Already in Merit: {top.name} — {top.usage}</>}
      >
        <span>{matchedWords(top.matched)}{top.city ? ` · ${top.city}` : ''}{top.email ? ` · ${top.email}` : ''}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <Button variant="primary" onClick={() => onUseExisting(top)}>Use existing</Button>
          <Button onClick={() => { setDismissedKey(key); onDecision?.('create_anyway'); }}>Create anyway</Button>
          <a href={href} style={{ fontSize: 12 }}>Review possible duplicates →</a>
        </div>
        {rest.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 6 }} aria-label={`Other possible ${noun} matches`}>
            {rest.map((m) => (
              <li key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span><b>{m.name}</b> — {m.usage}</span>
                <Tag tone={m.level === 'exact' ? 'warn' : 'default'}>{matchedWords(m.matched)}</Tag>
                <Button variant="quiet" onClick={() => onUseExisting(m)}>Use this one</Button>
              </li>
            ))}
          </ul>
        )}
      </InlineNotice>
    </div>
  );
}

export default MatchBeforeCreate;
