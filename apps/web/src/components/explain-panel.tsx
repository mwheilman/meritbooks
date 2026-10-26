'use client';

/**
 * ExplainPanel — the reusable, object-agnostic "Explain this ___" drawer/panel.
 *
 * Drop it onto any record detail: `<ExplainPanel kind="JOURNAL_ENTRY" id={id} />`.
 * It calls GET /api/explain, which deterministically gathers the record's facts
 * and (when available) has the Core AI gateway PHRASE them — the model may word
 * the paragraph but every figure comes from the ledger. The panel surfaces the
 * grounded narrative, a per-line debit/credit direction breakdown, and a
 * "Based on" fact list with links to the underlying records.
 *
 * Kit grammar: AI is a note (Sky ground, Electric inset), never a chat bubble;
 * figures are DM Sans tabular, right-aligned, never coloured by debit/credit.
 * Kit classes only (no Tailwind), so it renders the same on ported and bridged pages.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Button, Icon, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import type { ExplainKind, ExplainResult } from '@/lib/explain';
import s from './explain-panel.module.css';

interface ExplainPanelProps {
  kind: ExplainKind;
  id: string;
  /** Optional heading override. */
  title?: string;
  className?: string;
}

const KIND_NOUN: Record<ExplainKind, string> = {
  JOURNAL_ENTRY: 'entry',
  BILL: 'bill',
  BANK_TRANSACTION: 'transaction',
  PAYMENT: 'payment',
  INVOICE: 'invoice',
};

export function ExplainPanel({ kind, id, title, className }: ExplainPanelProps) {
  // On-demand: don't spend AI budget until the user asks. `run` flips enabled.
  const [run, setRun] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<ExplainResult>(
    '/api/explain',
    { kind, id },
    { enabled: run && !!id },
  );

  const heading = title ?? `Explain this ${KIND_NOUN[kind]}`;

  return (
    <section className={['note', 'note--panel', s.root, className].filter(Boolean).join(' ')} aria-label={heading}>
      <div className={s.head}>
        <Tag tone="ai">AI explanation</Tag>
        {!run ? (
          <Button variant="quiet" icon="ask" onClick={() => setRun(true)}>
            Explain
          </Button>
        ) : (
          <Button variant="quiet" icon="undo" onClick={() => void refetch()} disabled={isLoading} aria-busy={isLoading || undefined}>
            Regenerate
          </Button>
        )}
      </div>
      <h4 className={`note-title ${s.title}`}>{heading}</h4>

      {/* Idle */}
      {!run && (
        <p className="ink-2">
          Get a plain-English, ledger-grounded explanation of what this {KIND_NOUN[kind]} is, why it debits and credits
          the way it does, and who or what proposed and approved it.
        </p>
      )}

      {/* Loading */}
      {run && isLoading && (
        <div className={`wg-loading ${s.loading}`} aria-busy="true">
          <span className="bar-l" style={{ width: '88%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
          <span className="t-cap" role="status">
            Gathering the facts and drafting the explanation…
          </span>
        </div>
      )}

      {/* Error */}
      {run && !isLoading && error && (
        <InlineNotice tone="neg" title="The explanation didn’t build.">
          {error}{' '}
          <Button variant="quiet" onClick={() => void refetch()}>
            Try again
          </Button>
        </InlineNotice>
      )}

      {/* Populated */}
      {run && !isLoading && !error && data && (
        <div className={s.body}>
          {/* Narrative */}
          <p className="ink">{data.narrative}</p>

          {/* Provenance */}
          <div className="basis">
            <span>
              <b>
                {data.meta.source === 'ai'
                  ? `AI-phrased · figures from the ledger${data.meta.model ? ` · ${data.meta.model}` : ''}`
                  : 'Deterministic (AI unavailable)'}
              </b>
            </span>
            {data.meta.message && data.meta.source === 'deterministic' && <span>{data.meta.message}</span>}
          </div>

          {/* Posting lines with derived direction */}
          {data.explanation.lines.length > 0 && (
            <div>
              <h5 className={s.sub}>Posting lines</h5>
              <ul className={s.lines}>
                {data.explanation.lines.map((l, i) => {
                  const isDebit = l.side === 'debit';
                  const increase = l.effect === 'increase';
                  return (
                    <li key={`${l.accountNumber}-${i}`} className={s.line}>
                      <span className={s.lineMain}>
                        <span className="l1">
                          <span className="code">{l.accountNumber}</span>
                          {l.accountName}
                        </span>
                        <span className="l2">
                          <Icon name={increase ? 'up' : 'down'} size={12} className={s.dir} />
                          {isDebit ? 'Debit' : 'Credit'} · {increase ? 'increases' : 'decreases'} this {l.accountType.toLowerCase()} account
                        </span>
                      </span>
                      <span className={`tnum ${s.amt}`}>
                        <span className="sr">{isDebit ? 'Debit ' : 'Credit '}</span>
                        {formatMoney(l.amountCents)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Based on — the fact list */}
          {data.explanation.facts.length > 0 && (
            <div>
              <h5 className={s.sub}>Based on</h5>
              <dl className={s.facts}>
                {data.explanation.facts.map((f) => (
                  <div key={f.label} className={s.fact}>
                    <dt className="t-cap">{f.label}</dt>
                    <dd className={f.mono ? 'tnum' : undefined} title={typeof f.value === 'string' ? f.value : undefined}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Automation / approval trail */}
          {(data.explanation.proposedBy || data.explanation.approvedBy) && (
            <div className="basis">
              {data.explanation.proposedBy && (
                <span>
                  Proposed: <b>{data.explanation.proposedBy.label}</b>
                  {data.explanation.proposedBy.detail ? ` (${data.explanation.proposedBy.detail})` : ''}
                </span>
              )}
              {data.explanation.approvedBy && (
                <span>
                  Approval: <b>{data.explanation.approvedBy.label}</b>
                  {data.explanation.approvedBy.detail ? ` (${data.explanation.approvedBy.detail})` : ''}
                </span>
              )}
            </div>
          )}

          {/* Links to underlying records */}
          {data.explanation.links.length > 0 && (
            <div className="note-acts">
              {data.explanation.links.map((lnk) => {
                const external = lnk.href.startsWith('http');
                return external ? (
                  <a key={lnk.href + lnk.label} href={lnk.href} target="_blank" rel="noopener noreferrer" className="btn btn--quiet">
                    {lnk.label}
                    <Icon name="right" />
                    <span className="sr"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <Link key={lnk.href + lnk.label} href={lnk.href} className="btn btn--quiet">
                    {lnk.label}
                    <Icon name="right" />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
