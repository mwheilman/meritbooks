'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Field, InlineNotice, Radio, Textarea, api, useDebounce } from '@meritbooks/merit-ui';
import {
  NEW_REASON_MIN, alreadyInMerit, candidateLine, matchVerdict, matchWorthAsking, reconcileDecision,
  type MatchCandidate, type MatchDecision, type MatchKind, type MatchVerdict,
} from '@/lib/parties/match';

export interface DoorQuery {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxId?: string | null;
}

const NOUN: Readonly<Record<MatchKind, string>> = { customer: 'customer', vendor: 'vendor', contact: 'contact' };

/**
 * Ask core.match_parties as the person types (debounced) and keep the verdict. `conflict` is the
 * candidate list a 409 MATCH_FOUND answered with (the server's own check), shown at once.
 */
export function useDoorMatch(kind: MatchKind, q: DoorQuery, conflict?: ReadonlyArray<MatchCandidate> | null) {
  const key = JSON.stringify([q.name?.trim() ?? '', q.email?.trim() ?? '', q.phone?.trim() ?? '', q.address?.trim() ?? '', q.taxId?.trim() ?? '']);
  const debounced = useDebounce(key, 350);
  const [cands, setCands] = useState<MatchCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const [name, email, phone, address, taxId] = JSON.parse(debounced) as string[];
    const query = { name: name || null, email: email || null, phone: phone || null, taxId: taxId || null };
    if (!matchWorthAsking(query)) {
      setCands([]);
      setError(null);
      return;
    }
    setLoading(true);
    void api.post<{ candidates: MatchCandidate[] }>('/api/crm/match', { op: kind, ...query, address: address || null, limit: 5 }).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.error) {
        setError('We couldn’t check for an existing record. The save checks again.');
        return;
      }
      setError(null);
      setCands(r.data?.candidates ?? []);
    });
    return () => {
      live = false;
    };
  }, [debounced, kind]);

  const all = useMemo(() => {
    if (!conflict?.length) return cands;
    const seen = new Set(conflict.map((c) => c.id));
    return [...conflict, ...cands.filter((c) => !seen.has(c.id))];
  }, [cands, conflict]);
  const verdict = useMemo(() => matchVerdict(all), [all]);
  return { verdict, loading, error };
}

export interface MatchAtTheDoorProps {
  kind: MatchKind;
  verdict: MatchVerdict;
  decision: MatchDecision | null;
  onDecision: (d: MatchDecision | null) => void;
  loading?: boolean;
  error?: string | null;
  /** Shown when the form tried to save without a valid choice. */
  problem?: string | null;
}

/**
 * Matching at the door (SHARED-RECORDS §3), the one component every create form uses:
 *   exact identifier → "Already in Merit: <name> — used in Books since <date>", existing chosen
 *                      by default; adding a new one needs a typed reason
 *   likely matches   → pick one, or add a new one
 *   nothing          → renders nothing
 */
export function MatchAtTheDoor({ kind, verdict, decision, onDecision, loading, error, problem }: MatchAtTheDoorProps) {
  const uid = useId();
  const noun = NOUN[kind];
  const year = new Date().getFullYear();
  const last = useRef<MatchVerdict | null>(null);

  // New candidates: keep the person's choice when it still applies, else the verdict's default.
  useEffect(() => {
    if (last.current === verdict) return;
    last.current = verdict;
    const next = reconcileDecision(decision, verdict);
    if (JSON.stringify(next) !== JSON.stringify(decision)) onDecision(next);
  }, [verdict, decision, onDecision]);

  if (verdict.kind === 'none') {
    if (error) return <span className="field-help" role="status">{error}</span>;
    return loading ? <span className="field-help" role="status">Checking your records…</span> : null;
  }

  const options: MatchCandidate[] = verdict.kind === 'exact' ? [verdict.best, ...verdict.others] : verdict.options;
  const creating = !!decision && 'create' in decision;
  const reason = decision && 'create' in decision ? decision.reason ?? '' : '';
  const chosen = decision && 'use' in decision ? decision.use : null;

  return (
    <div className="crm-door" role="group" aria-labelledby={`${uid}-h`}>
      <InlineNotice
        tone={verdict.kind === 'exact' ? 'info' : 'warn'}
        title={<span id={`${uid}-h`}>{verdict.kind === 'exact' ? alreadyInMerit(verdict.best, year) : `This may already be in Merit: ${options.length === 1 ? options[0]!.name : `${options.length} possible ${noun}s`}`}</span>}
      >
        {verdict.kind === 'exact' ? `Use it so Projects and Books keep one ${noun}.` : `Pick the ${noun} if it is the same one, or add a new ${noun}.`}
      </InlineNotice>
      <ul className="crm-door-list">
        {options.map((c) => (
          <li key={c.id}>
            <Radio name={`${uid}-pick`} checked={chosen === c.id} onChange={() => onDecision({ use: c.id })}
              label={<span className="crm-door-opt"><span className="l1">Use {c.name}</span><span className="l2">{candidateLine(c)}</span></span>} />
          </li>
        ))}
        <li>
          <Radio name={`${uid}-pick`} checked={creating} onChange={() => onDecision({ create: true, reason })}
            label={<span className="crm-door-opt"><span className="l1">Add a new {noun}</span><span className="l2">{verdict.kind === 'exact' ? 'Only when it really is a different one' : 'None of these is the same'}</span></span>} />
        </li>
      </ul>
      {creating && verdict.kind === 'exact' && (
        <Field
          label={`Why is this a different ${noun}?`}
          help={`At least ${NEW_REASON_MIN} characters. It is kept with the new record.`}
          error={problem ?? undefined}
        >
          <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => onDecision({ create: true, reason: e.target.value })} placeholder={`e.g. Same name, different ${kind === 'customer' ? 'household' : 'business'} in another town`} />
        </Field>
      )}
      {problem && !(creating && verdict.kind === 'exact') && <span className="field-error" role="alert">{problem}</span>}
    </div>
  );
}
