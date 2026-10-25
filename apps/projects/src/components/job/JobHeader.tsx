'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, ConfirmDialog, Icon, InlineNotice, Keys, Popover, PopoverFoot, PopoverGroup, PopoverItem, PopoverList,
  StageMeter, Status, Tag, pct, toast,
} from '@meritbooks/merit-ui';
import { dollars } from '@/lib/pm/money';
import { stageStatus, CORE_STATUS_WORDS } from '@/lib/pm/stage';
import { guardsSentence } from '@/lib/pm/guards';
import type { CoreStatus } from '@/lib/pm/types';
import { useShell } from '@/components/shell/ShellContext';
import { useAction } from './useAction';
import type { HeaderFigure } from './header-figures';
import './job.css';

export interface NextStage {
  to_stage: string;
  label: string;
  core_status: CoreStatus | null;
  guards: string[];
}

/** The one thing to do next: fix what blocks the next stage, or move to it. */
export type PrimaryAction =
  | { kind: 'move'; to: string; label: string }
  | { kind: 'fix'; label: string; href: string; why: string }
  | null;

export interface HeaderPerson {
  role: string;
  name: string;
}

export interface JobHeaderProps {
  jobId: string;
  companyId: string;
  number: string | null;
  name: string;
  customer: { id: string | null; name: string } | null;
  site: { label: string; mapHref: string | null } | null;
  stageLabel: string;
  coreStatus: CoreStatus;
  people: HeaderPerson[];
  jobTypeLabel: string;
  companyName: string | null;
  isSample: boolean;
  stages: Array<{ key: string; label: string; terminal: boolean }>;
  currentStage: string;
  next: NextStage[];
  primary: PrimaryAction;
  figures: HeaderFigure[];
  /** "Updates from Books" stamp for money figures, when Books is on. */
  booksNote: string | null;
}

interface Failing {
  guard: string;
  sentence: string;
  fix: { label: string; href: string };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '·';
}

function figureText(f: HeaderFigure): string {
  if (f.value == null) return '—';
  if (f.kind === 'money' && typeof f.value === 'number') return dollars(f.value);
  if (f.kind === 'pct' && typeof f.value === 'number') return pct(f.value);
  if (f.kind === 'count' && typeof f.value === 'number') return f.value.toLocaleString('en-US');
  return String(f.value);
}

/**
 * Sticky two-row job header (UX seat §3d). Row 1: number · name · stage bar · PM/super ·
 * the primary next action · ⋯. Row 2: customer and site links, then four figures by money level,
 * each linking to its breakdown.
 */
export function JobHeader(p: JobHeaderProps) {
  const router = useRouter();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const moveAnchor = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [blocked, setBlocked] = useState<{ to: string; failing: Failing[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = stageStatus(p.coreStatus);

  const path = p.stages.filter((x) => !x.terminal || x.key === p.currentStage);
  const idx = Math.max(0, path.findIndex((x) => x.key === p.currentStage));
  const atEnd = p.stages.find((x) => x.key === p.currentStage)?.terminal ?? false;

  const move = async (to: string, label: string) => {
    setOpen(false);
    const res = await run<{ moved: boolean; failing: Failing[] }>('stage', 'post', `/api/jobs/${p.jobId}/stage`, { to }, (d) => (d.moved ? `Moved to ${label}` : null));
    if (res.data && !res.data.moved) setBlocked({ to: label, failing: res.data.failing });
    else if (res.data?.moved) setBlocked(null);
  };

  return (
    <header className="job-sticky" aria-label="Job">
      <div className="job-row1">
        <div className="job-id">
          <span className="job-eyebrow">
            {[p.jobTypeLabel, ...(p.companyName ? [p.companyName] : [])].join(' // ')}
            {p.isSample && <Tag tone="warn">Sample</Tag>}
          </span>
          <h1 className="t-title job-name">
            {p.number ? <span className="ink-3 tnum">{p.number} · </span> : null}
            {p.name}
          </h1>
        </div>
        {path.length > 1 && (
          <div className="job-stage">
            <StageMeter stages={path.map((x) => x.label)} current={atEnd ? path.length : idx} blocked={!!blocked} detail={<Status kind={s.kind} pip={s.pip}>{CORE_STATUS_WORDS[p.coreStatus]}</Status>} />
          </div>
        )}
        <ul className="job-people" aria-label="Job leads">
          {p.people.length === 0 && <li className="ink-3 t-cap">No PM assigned</li>}
          {p.people.map((x) => (
            <li key={`${x.role}:${x.name}`} title={`${x.role}: ${x.name}`}>
              <span className="job-av" aria-hidden="true">{initials(x.name)}</span>
              <span className="job-av-l"><span className="t-cap ink-3">{x.role}</span>{x.name}</span>
            </li>
          ))}
        </ul>
        <div className="btn-row job-actions">
          {!readOnly && p.primary?.kind === 'fix' && (
            <ButtonLink variant="primary" href={p.primary.href} title={p.primary.why}>{p.primary.label}</ButtonLink>
          )}
          {!readOnly && p.primary?.kind === 'move' && (() => {
            const mv = p.primary;
            return (
              <Button variant="primary" disabled={busy === 'stage'} onClick={() => void move(mv.to, mv.label.replace(/^Move to /, ''))}>
                {busy === 'stage' ? 'Moving…' : mv.label}
              </Button>
            );
          })()}
          {!readOnly && (
            <Button
              ref={moveAnchor}
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
              {p.next.length === 0 ? (atEnd ? 'Final stage' : 'No moves') : 'Stage'}
            </Button>
          )}
          <Button ref={moreAnchor} variant="quiet" aria-label="More job actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
            <Icon name="more" />
          </Button>
        </div>
      </div>

      <div className="job-row2">
        <div className="job-links">
          {p.customer ? (
            p.customer.id ? <Link className="link" href={`/customers/${p.customer.id}`}>{p.customer.name}</Link> : <span>{p.customer.name}</span>
          ) : (
            <span className="ink-3">No customer yet</span>
          )}
          {p.site && (
            p.site.mapHref
              ? <a className="link" href={p.site.mapHref} target="_blank" rel="noreferrer"><Icon name="pin" /> {p.site.label}</a>
              : <span><Icon name="pin" /> {p.site.label}</span>
          )}
        </div>
        <dl className="job-figs" aria-label="Key figures">
          {p.figures.map((f) => (
            <div key={f.key} className={f.tone ? `job-fig is-${f.tone}` : 'job-fig'}>
              <dt>{f.label}</dt>
              <dd>
                <Link href={f.href} className="tnum" aria-label={`${f.label} ${figureText(f)}. Open the breakdown`}>{figureText(f)}</Link>
                {f.sub ? <span className="t-cap ink-3">{f.sub}</span> : null}
              </dd>
            </div>
          ))}
          {p.booksNote && <div className="job-fig-note t-cap ink-3">{p.booksNote}</div>}
        </dl>
      </div>

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

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={moveAnchor} width={360} placement="bottom-end" aria-label="Move to stage" role="dialog">
        <PopoverList
          role="listbox"
          aria-label="Next stages"
          tabIndex={0}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % p.next.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + p.next.length) % p.next.length); }
            else if (e.key === 'Enter') { e.preventDefault(); const n = p.next[cursor]; if (n) void move(n.to_stage, n.label); }
          }}
        >
          <PopoverGroup label={`From ${p.stageLabel}`} meta={String(p.next.length)} />
          {p.next.map((n, i) => (
            <PopoverItem
              key={n.to_stage}
              active={i === cursor}
              onMouseMove={() => setCursor(i)}
              onClick={() => void move(n.to_stage, n.label)}
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

      <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreAnchor} width={280} placement="bottom-end" aria-label="More job actions" role="menu">
        <PopoverList role="menu" aria-label="Job actions">
          <PopoverItem onClick={() => { setMoreOpen(false); router.push(`/jobs/${p.jobId}?tab=activity`); }}>All activity</PopoverItem>
          <PopoverItem onClick={() => { setMoreOpen(false); router.push(`/jobs/${p.jobId}?tab=team`); }}>People on this job</PopoverItem>
          <PopoverItem
            onClick={() => {
              setMoreOpen(false);
              void navigator.clipboard?.writeText(`${window.location.origin}/jobs/${p.jobId}`).then(() => toast('Link copied'), () => toast.error('Could not copy the link'));
            }}
          >
            Copy link
          </PopoverItem>
          {p.isSample && !readOnly && (
            <PopoverItem onClick={() => { setMoreOpen(false); setConfirmRemove(true); }}>Remove sample data</PopoverItem>
          )}
        </PopoverList>
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
