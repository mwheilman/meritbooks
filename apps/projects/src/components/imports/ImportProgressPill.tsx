'use client';

import { useState } from 'react';
import { Button, Icon, Pip, type PipKind } from '@meritbooks/merit-ui';
import { clearFinished, useImportActivity, type ActivityPhase } from './activity';
import './imports.css';

const PIP: Record<ActivityPhase, PipKind> = { reading: 'track', staged: 'open', committing: 'track', done: 'ready', error: 'blocked' };
const WORD: Record<ActivityPhase, string> = { reading: 'Reading', staged: 'Ready to check', committing: 'Bringing in', done: 'Done', error: 'Needs a look' };

/** The header pill: "Importing 2 files…" → a small list of what is running and what finished. */
export function ImportProgressPill() {
  const items = useImportActivity();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const running = items.filter((i) => i.phase === 'reading' || i.phase === 'committing').length;
  const failed = items.filter((i) => i.phase === 'error').length;
  const label = running > 0 ? `Importing ${running} ${running === 1 ? 'file' : 'files'}…` : failed > 0 ? `${failed} import${failed === 1 ? '' : 's'} need a look` : `${items.length} import${items.length === 1 ? '' : 's'} done`;
  return (
    <div className="imp-pill-wrap">
      <button type="button" className="imp-pill" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Pip kind={running ? 'track' : failed ? 'blocked' : 'ready'} />
        <span className="tnum">{label}</span>
        <Icon name={open ? 'up' : 'down'} />
      </button>
      {open && (
        <div className="imp-pill-pop" role="region" aria-label="Imports">
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <Pip kind={PIP[i.phase]} />
                <span className="l1">{i.label}</span>
                <span className="t-cap">{WORD[i.phase]}{i.detail ? ` · ${i.detail}` : ''}</span>
              </li>
            ))}
          </ul>
          {running === 0 && <div className="imp-pill-foot"><Button variant="quiet" onClick={() => { clearFinished(); setOpen(false); }}>Clear</Button></div>}
        </div>
      )}
    </div>
  );
}
