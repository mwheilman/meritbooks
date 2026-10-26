'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Button, Conf, Field, InlineNotice, Input, Select, Status, Tag, Textarea, cx } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { AccountPicker } from './je-account-picker';
import s from './je.module.css';

interface LocationOption { id: string; name: string; short_code: string }

interface ProposalLine {
  account_id: string | null;
  account_number: string;
  account_label: string;
  debit_cents: number;
  credit_cents: number;
  memo: string | null;
}
interface Proposal {
  memo: string;
  lines: ProposalLine[];
  balanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  prediction: { type: 'NONE' | 'CAPEX' | 'PREPAID' | 'DEFERRED_REVENUE'; rationale: string | null };
  confidence: number;
  clarifyingQuestion: string | null;
  notes: string | null;
  unresolvedAccounts: string[];
}

interface EditLine { account_id: string | null; account_number: string; account_label: string; debit: string; credit: string; memo: string }

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (s: string) => Math.round((Number(String(s).replace(/[$,\s]/g, '')) || 0) * 100);

const PREDICTION_LABEL: Record<string, string> = {
  CAPEX: 'Looks like a capital expense',
  PREPAID: 'Looks like a prepaid expense',
  DEFERRED_REVENUE: 'Looks like deferred revenue',
};

export function JeAiComposer({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { activeCompanyId } = useActiveCompany();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locLoading, setLocLoading] = useState(true);
  const [locationId, setLocationId] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ costCents: number; budgetState: string; message: string | null } | null>(null);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  useEffect(() => {
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: LocationOption[]) => {
        const arr = Array.isArray(d) ? d : [];
        setLocations(arr);
        if (arr.length === 1) setLocationId(arr[0].id);
        // Otherwise start on the company the header is scoped to.
        else if (isSpecificCompany(activeCompanyId) && arr.some((l) => l.id === activeCompanyId)) setLocationId(activeCompanyId);
      })
      .catch(() => setLocations([]))
      .finally(() => setLocLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compose = useCallback(async () => {
    setError(''); setProposal(null); setPostError(''); setDecisionId(null); setGateway(null);
    if (!locationId) { setError('Select a company first.'); return; }
    if (description.trim().length < 3) { setError('Describe the transaction first.'); return; }
    setComposing(true);
    try {
      const res = await fetch('/api/journal-entries/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, location_id: locationId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Compose failed'); return; }
      const p = data.proposal as Proposal;
      setProposal(p);
      setDecisionId(data.decisionId ?? null);
      setGateway(data.gateway ? { costCents: data.gateway.costCents, budgetState: data.gateway.budgetState, message: data.gateway.message } : null);
      setMemo(p.memo);
      setLines(p.lines.map((l) => ({
        account_id: l.account_id,
        account_number: l.account_number,
        account_label: l.account_label,
        debit: l.debit_cents ? fmt(l.debit_cents) : '',
        credit: l.credit_cents ? fmt(l.credit_cents) : '',
        memo: l.memo ?? '',
      })));
    } catch {
      setError('Could not reach the composer.');
    } finally {
      setComposing(false);
    }
  }, [locationId, description]);

  const totals = useMemo(() => {
    const d = lines.reduce((sum, l) => sum + toCents(l.debit), 0);
    const c = lines.reduce((sum, l) => sum + toCents(l.credit), 0);
    return { d, c, balanced: d === c && d > 0 };
  }, [lines]);

  const allResolved = lines.length >= 2 && lines.every((l) => l.account_id);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const post = useCallback(async () => {
    setPostError('');
    if (!totals.balanced) { setPostError('Entry is not balanced.'); return; }
    if (!allResolved) { setPostError('Every line needs a valid account.'); return; }
    setPosting(true);
    try {
      const payload = {
        location_id: locationId,
        entry_date: entryDate,
        entry_type: 'STANDARD' as const,
        memo,
        post_immediately: true,
        decision_id: decisionId ?? undefined,
        lines: lines
          .filter((l) => l.account_id && (toCents(l.debit) > 0 || toCents(l.credit) > 0))
          .map((l) => ({
            account_id: l.account_id as string,
            debit_cents: toCents(l.debit),
            credit_cents: toCents(l.credit),
            location_id: locationId,
            memo: l.memo || null,
          })),
      };
      const res = await fetch('/api/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setPostError(data.error ?? 'Failed to post entry'); return; }
      onSuccess();
    } catch {
      setPostError('Could not post the entry.');
    } finally {
      setPosting(false);
    }
  }, [totals.balanced, allResolved, locationId, entryDate, memo, lines, decisionId, onSuccess]);

  const confidencePct = proposal ? Math.round(proposal.confidence * 100) : 0;

  return (
    <section className={s.form} aria-label="Compose a journal entry with AI">
      <div className={s.formHead}>
        <div className={s.formHeadMain}>
          <h2 className="t-section">Compose with AI</h2>
          <span className="t-cap">Advisory — you review every line and post it yourself.</span>
        </div>
        <Button variant="quiet" iconOnly icon="x" onClick={onClose} aria-label="Close AI composer" />
      </div>

      <div className={s.formBody}>
        <div className={s.grid3}>
          <Field label="Company">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={locLoading}>
              <option value="">{locLoading ? 'Loading companies…' : 'Select a company…'}</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.short_code})</option>)}
            </Select>
          </Field>
          <Field label="Entry date">
            <Input type="date" className="tnum" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Describe the transaction in plain English" error={error || undefined}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="e.g. Paid $1,200 for a 12-month business insurance policy by check from operating checking."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!composing) void compose(); }
            }}
          />
        </Field>

        <div className={s.formActs}>
          <Button variant={proposal ? 'default' : 'primary'} chord="mod+enter" onClick={compose} disabled={composing} aria-busy={composing || undefined}>
            {composing ? 'Composing…' : proposal ? 'Compose again' : 'Compose entry'}
          </Button>
        </div>

        {composing && !proposal && (
          <div className={cx('wg-loading', s.peekState)} aria-busy="true">
            <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
            <span className="bar-l" style={{ width: '80%' }} aria-hidden="true" />
            <span className="bar-l" style={{ width: '45%' }} aria-hidden="true" />
            <span className="sr" role="status">Drafting the entry</span>
          </div>
        )}

        {proposal && (
          <>
            {proposal.clarifyingQuestion && (
              <InlineNotice tone="warn" title="Before you post:">{proposal.clarifyingQuestion}</InlineNotice>
            )}
            {proposal.prediction.type !== 'NONE' && (
              <InlineNotice tone="info" title={`${PREDICTION_LABEL[proposal.prediction.type] ?? proposal.prediction.type.replace('_', ' ')}.`}>
                {proposal.prediction.rationale}
              </InlineNotice>
            )}
            {proposal.notes && <p className="ink-2">{proposal.notes}</p>}
            {proposal.unresolvedAccounts.length > 0 && (
              <InlineNotice tone="neg" title="Account not in your chart.">
                The AI referenced {proposal.unresolvedAccounts.join(', ')}. Pick a real account on each flagged line before posting.
              </InlineNotice>
            )}

            <Field label="Memo">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>

            <div className={s.lines}>
              <table className="tbl" aria-label="Proposed lines">
                <colgroup>
                  <col />
                  <col style={{ width: 220 }} />
                  <col style={{ width: 140 }} />
                  <col style={{ width: 140 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Line memo</th>
                    <th scope="col" className="n">Debit</th>
                    <th scope="col" className="n">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <div className={s.lineAcct}>
                          <AccountPicker
                            value={l.account_id ?? ''}
                            label={l.account_id ? l.account_label : ''}
                            ariaLabel={`Line ${i + 1} account`}
                            invalid={!l.account_id}
                            locationId={locationId}
                            onChange={(id, label, acct) => updateLine(i, { account_id: id, account_label: label, account_number: acct.account_number })}
                          />
                          {!l.account_id && (
                            <span className={s.cellRow}>
                              <Tag tone="neg">Not in chart</Tag>
                              <span className="t-cap mb-trunc">AI suggested {l.account_label}</span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Input value={l.memo} onChange={(e) => updateLine(i, { memo: e.target.value })} placeholder="—" aria-label={`Line ${i + 1} memo`} />
                      </td>
                      <td>
                        <span className={s.money}>
                          <span aria-hidden="true">$</span>
                          <input
                            value={l.debit}
                            onChange={(e) => updateLine(i, { debit: e.target.value, credit: '' })}
                            aria-label={`Line ${i + 1} debit amount`}
                            inputMode="decimal"
                            autoComplete="off"
                            className="input input--money"
                            placeholder="0.00"
                          />
                        </span>
                      </td>
                      <td>
                        <span className={s.money}>
                          <span aria-hidden="true">$</span>
                          <input
                            value={l.credit}
                            onChange={(e) => updateLine(i, { credit: e.target.value, debit: '' })}
                            aria-label={`Line ${i + 1} credit amount`}
                            inputMode="decimal"
                            autoComplete="off"
                            className="input input--money"
                            placeholder="0.00"
                          />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{totals.balanced ? <Status kind="ready">Balanced</Status> : <Status kind="blocked">Out of balance</Status>}</td>
                    <td className="t-cap">Totals</td>
                    <td className="n">${fmt(totals.d)}</td>
                    <td className="n">${fmt(totals.c)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {postError && <InlineNotice tone="neg" title="Not posted.">{postError}</InlineNotice>}

            <div className={s.formFoot}>
              <div className={s.meta}>
                <Conf score={confidencePct} label={`AI confidence ${confidencePct} of 100`} />
                {gateway && (
                  <span className="t-cap tnum" title={`Budget: ${gateway.budgetState}`}>
                    Metered ${(gateway.costCents / 100).toFixed(4)}
                  </span>
                )}
                {decisionId && <span className="t-cap">Logged for audit</span>}
                {gateway?.message && <Tag tone="warn">{gateway.message}</Tag>}
              </div>
              <div className={s.formActs}>
                <Button variant="quiet" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  icon="check"
                  onClick={post}
                  disabled={posting || !totals.balanced || !allResolved}
                  aria-busy={posting || undefined}
                >
                  {posting ? 'Posting…' : 'Post entry'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
