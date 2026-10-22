'use client';

import { useMemo, useState } from 'react';
import { Button, Pip, QueueTable, Widget, type PipKind, type QueueColumn } from '@meritbooks/merit-ui';
import type { CompanyBoard, PeriodStatus } from './actions';
import { useEnterCompany } from './enter-company';
import { PERIOD_WORD, centsCompact } from './home-format';

/** Pip shape by how the client is going: attention first, then period state. */
function pipFor(c: CompanyBoard): { kind: PipKind; word: string } {
  if (c.needsAttention > 0) return { kind: 'risk', word: `${c.needsAttention} need attention` };
  if (c.periodStatus === 'HARD_CLOSE') return { kind: 'closed', word: 'Closed' };
  if (c.totalOpen === 0) return { kind: 'ready', word: 'Caught up' };
  if (c.periodStatus === 'SOFT_CLOSE') return { kind: 'soft', word: 'Soft close' };
  return { kind: 'track', word: 'On track' };
}

const PERIOD_PIP: Record<PeriodStatus, PipKind> = { OPEN: 'open', SOFT_CLOSE: 'soft', HARD_CLOSE: 'closed', NO_PERIOD: 'track' };

function CountCell({ n, onOpen, label }: { n: number; onOpen: () => void; label: string }) {
  if (n === 0) return <span className="ink-3">0</span>;
  return (
    <button
      type="button"
      className="mb-nlink tnum"
      aria-label={`${n.toLocaleString()} ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {n.toLocaleString()}
    </button>
  );
}

/**
 * Module 1 of the workspace home (board S1, primary, 8 of 12): every client ranked
 * by what needs a person — attention, then AI proposals, then open work. J/K move,
 * ↵ opens the client's home; each count opens that queue inside the client.
 */
export function WorkspaceClients({ companies }: { companies: CompanyBoard[] }) {
  const enter = useEnterCompany();
  const [cursor, setCursor] = useState<string | null>(companies[0]?.id ?? null);

  const columns = useMemo<QueueColumn<CompanyBoard>[]>(
    () => [
      {
        id: 'client',
        header: 'Client',
        cell: (c) => {
          const s = pipFor(c);
          return (
            <span className="mb-client-cell">
              <Pip kind={s.kind} />
              <span style={{ minWidth: 0 }}>
                <span className="l1">{c.name}</span>
                <span className="l2">
                  {c.shortCode} · {s.word}
                  {c.isOwnBooks ? ' · Own books' : ''}
                </span>
              </span>
            </span>
          );
        },
      },
      {
        id: 'period',
        header: 'Period',
        width: 120,
        cell: (c) => (
          <span className="mb-period">
            <Pip kind={PERIOD_PIP[c.periodStatus]} />
            {PERIOD_WORD[c.periodStatus]}
          </span>
        ),
      },
      { id: 'review', header: 'To review', numeric: true, width: 84, cell: (c) => <CountCell n={c.toReview} label="to review" onOpen={() => enter(c.id, '/bank-feed')} /> },
      { id: 'attention', header: 'Attention', numeric: true, width: 84, cell: (c) => <CountCell n={c.needsAttention} label="need attention" onOpen={() => enter(c.id, '/inbox?tab=exceptions')} /> },
      { id: 'ai', header: 'AI', numeric: true, width: 64, cell: (c) => <CountCell n={c.openExceptions} label="AI proposals" onOpen={() => enter(c.id, '/ai-decisions')} /> },
      { id: 'drafts', header: 'Drafts', numeric: true, width: 68, cell: (c) => <CountCell n={c.draftJEs} label="draft journal entries" onOpen={() => enter(c.id, '/journal-entries')} /> },
      { id: 'cash', header: 'Cash', numeric: true, width: 76, cell: (c) => <span className="tnum">{centsCompact(c.cashCents)}</span> },
    ],
    [enter],
  );

  const totals = useMemo(
    () => ({
      review: companies.reduce((n, c) => n + c.toReview, 0),
      attention: companies.reduce((n, c) => n + c.needsAttention, 0),
      open: companies.reduce((n, c) => n + c.totalOpen, 0),
    }),
    [companies],
  );
  const next = companies.find((c) => c.totalOpen > 0) ?? null;
  const withWork = companies.filter((c) => c.totalOpen > 0).length;

  return (
    <Widget
      primary
      title="Your clients"
      count={companies.length}
      meta={withWork > 0 ? `${withWork} with open work · most work first` : 'Everyone is caught up'}
      w={8}
      h={4}
      foot={
        <>
          <span className="tnum">
            {totals.open.toLocaleString()} open · {totals.review.toLocaleString()} to review · {totals.attention.toLocaleString()} need attention
          </span>
          {next ? (
            <Button variant="primary" iconAfter="right" chord="s" bindChord onClick={() => enter(next.id)}>
              Start {next.name}
            </Button>
          ) : null}
        </>
      }
    >
      <QueueTable
        aria-label="Your clients, most work first"
        columns={columns}
        rows={companies}
        getRowId={(c) => c.id}
        rowState={(c) => ({ attn: c.needsAttention > 0, done: c.totalOpen === 0 })}
        cursorId={cursor}
        onCursorChange={(id) => setCursor(id)}
        onOpen={(c) => enter(c.id)}
        flush
      />
    </Widget>
  );
}
