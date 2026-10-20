'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ConfirmDialog, Eyebrow, InlineNotice, Popover, PopoverFoot, PopoverGroup, PopoverItem, PopoverList, Keys,
  StageMeter, Status, Tag, toast,
} from '@meritbooks/merit-ui';
import { stageStatus, CORE_STATUS_WORDS } from '@/lib/pm/stage';
import { guardsSentence } from '@/lib/pm/guards';
import type { CoreStatus } from '@/lib/pm/types';
import { useShell } from '@/components/shell/ShellContext';
import { useAction } from './useAction';

export interface NextStage {
  to_stage: string;
  label: string;
  core_status: CoreStatus | null;
  guards: string[];
}

export interface JobHeaderProps {
  jobId: string;
  companyId: string;
  number: string | null;
  name: string;
  customer: string | null;
  stageLabel: string;
  coreStatus: CoreStatus;
  pmName: string | null;
  jobTypeLabel: string;
  companyName: string | null;
  isSample: boolean;
  stages: Array<{ key: string; label: string; terminal: boolean }>;
  currentStage: string;
  next: NextStage[];
}

interface Failing {
  guard: string;
  sentence: string;
  fix: { label: string; href: string };
}

export function JobHeader(p: JobHeaderProps) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [blocked, setBlocked] = useState<{ to: string; failing: Failing[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = stageStatus(p.coreStatus);

  const path = p.stages.filter((x) => !x.terminal || x.key === p.currentStage);
  const idx = Math.max(0, path.findIndex((x) => x.key === p.currentStage));
  const atEnd = p.stages.find((x) => x.key === p.currentStage)?.terminal ?? false;

  const move = async (n: NextStage) => {
    setOpen(false);
    const res = await run<{ moved: boolean; failing: Failing[] }>('stage', 'post', `/api/jobs/${p.jobId}/stage`, { to: n.to_stage }, (d) => (d.moved ? `Moved to ${n.label}` : null));
    if (res.data && !res.data.moved) setBlocked({ to: n.label, failing: res.data.failing });
    else if (res.data?.moved) setBlocked(null);
  };

  return (
    <header style={{ marginBottom: 16 }}>
      <div className="job-head">
        <div style={{ minWidth: 0 }}>
          <Eyebrow>{[p.jobTypeLabel, ...(p.companyName ? [p.companyName] : [])]}</Eyebrow>
          <h1 className="t-title" style={{ marginTop: 4 }}>
            {p.number ? `${p.number} · ` : ''}
            {p.name}
          </h1>
          <div className="meta">
            <span>{p.customer ?? <span className="ink-3">No customer yet</span>}</span>
            <Status kind={s.kind} pip={s.pip}>{p.stageLabel}</Status>
            <span>{p.pmName ? `PM ${p.pmName}` : <span className="ink-3">No PM assigned</span>}</span>
            {p.isSample && <Tag tone="warn">Sample</Tag>}
          </div>
        </div>
        <div className="btn-row">
          {p.isSample && !readOnly && (
            <Button variant="danger" onClick={() => setConfirmRemove(true)}>
              Remove sample data
            </Button>
          )}
          {!readOnly && (
            <Button
              ref={anchor}
              variant="primary"
              iconAfter="down"
              chord="m"
              bindChord
              disabled={p.next.length === 0 || busy === 'stage'}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => {
                setCursor(0);
                setOpen((o) => !o);
              }}
            >
              {p.next.length === 0 ? (atEnd ? 'Final stage' : 'No moves from here') : busy === 'stage' ? 'Moving…' : 'Move stage'}
            </Button>
          )}
        </div>
      </div>
      {path.length > 1 && (
        <StageMeter stages={path.map((x) => x.label)} current={atEnd ? path.length : idx} blocked={!!blocked} detail={`Job status: ${CORE_STATUS_WORDS[p.coreStatus].toLowerCase()}`} />
      )}

      {blocked && (
        <div style={{ marginTop: 12 }}>
          <InlineNotice tone="warn" title={`Not moved to ${blocked.to}.`}>
            {blocked.failing.length === 1 ? 'One check is not met:' : `${blocked.failing.length} checks are not met:`}
            <ul style={{ listStyle: 'none', marginTop: 4 }}>
              {blocked.failing.map((f) => (
                <li key={f.guard} style={{ marginTop: 2 }}>
                  {f.sentence}{' '}
                  <Link className="link" href={f.fix.href} onClick={() => setBlocked(null)}>
                    {f.fix.label}
                  </Link>
                </li>
              ))}
            </ul>
          </InlineNotice>
        </div>
      )}

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={360} placement="bottom-end" aria-label="Move to stage" role="dialog">
        <PopoverList
          role="listbox"
          aria-label="Next stages"
          tabIndex={0}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % p.next.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + p.next.length) % p.next.length); }
            else if (e.key === 'Enter') { e.preventDefault(); const n = p.next[cursor]; if (n) void move(n); }
          }}
        >
          <PopoverGroup label={`From ${p.stageLabel}`} meta={String(p.next.length)} />
          {p.next.map((n, i) => (
            <PopoverItem
              key={n.to_stage}
              active={i === cursor}
              onMouseMove={() => setCursor(i)}
              onClick={() => void move(n)}
              right={n.core_status ? <span className="ink-3">{CORE_STATUS_WORDS[n.core_status]}</span> : undefined}
            >
              <span style={{ minWidth: 0 }}>
                {n.label}
                <span className="l2">{guardsSentence(n.guards)}</span>
              </span>
            </PopoverItem>
          ))}
        </PopoverList>
        <PopoverFoot>
          <Keys chord="↑ ↓">move</Keys>
          <Keys chord="enter">choose</Keys>
          <Keys chord="escape">close</Keys>
        </PopoverFoot>
      </Popover>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        tone="danger"
        title="Remove sample data"
        confirmLabel="Remove sample data"
        onConfirm={async () => {
          const res = await run<{ removed: number; cancelled: number }>('sample', 'post', '/api/samples/remove', { companyId: p.companyId }, (d) =>
            d.cancelled ? `Removed ${d.removed} sample job; ${d.cancelled} kept as cancelled because Merit Books references it` : 'Removed sample data',
            { quietError: true },
          );
          if (res.error) throw new Error(res.error.error);
          toast('Your real jobs are untouched');
          router.push('/jobs');
        }}
      >
        This deletes the sample job for this company, with its budget, tasks and change orders. Real jobs are not touched.
      </ConfirmDialog>
    </header>
  );
}
