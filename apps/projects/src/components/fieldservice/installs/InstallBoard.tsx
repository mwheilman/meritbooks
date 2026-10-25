'use client';

import { useState } from 'react';
import { Status, Tag, WidgetState, count, money } from '@meritbooks/merit-ui';
import { INSTALL_STAGES, type InstallBoardRow, type InstallStage } from '@/lib/fieldservice/completion-types';
import { words } from '../common/useAction';
import { InstallDrawer, type InstallDrawerContext } from './InstallDrawer';

export interface InstallBoardProps extends InstallDrawerContext {
  projects: InstallBoardRow[];
  error: string | null;
}

const LABEL: Record<InstallStage, string> = {
  SOLD: 'Sold', ORDERED: 'Equipment ordered', PERMITTED: 'Permitted', SCHEDULED: 'Scheduled', INSTALLED: 'Installed', INSPECTED: 'Inspected', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};

/**
 * The install stage board (FS-79): sold → ordered → permitted → scheduled → installed → inspected
 * → closed, with what still blocks each install (equipment, permit), the install date and installs
 * stuck too long in a stage. Click a card for the handoff brief, POs, permits, crew, commissioning,
 * billing and job costing.
 */
export function InstallBoard(p: InstallBoardProps) {
  const [open, setOpen] = useState<string | null>(null);
  if (p.error) return <WidgetState state={{ kind: 'error', title: 'The install board did not load', body: p.error }} />;
  if (p.projects.length === 0) {
    return <WidgetState state={{ kind: 'empty', title: 'No installs yet', body: 'A signed replacement proposal with equipment becomes an install project here automatically — equipment list, scope, photos and notes carried over.' }} />;
  }
  const current = p.projects.find((x) => x.id === open) ?? null;
  return (
    <>
      <div className="fs-board" role="list" aria-label="Install stages">
        {INSTALL_STAGES.map((s) => {
          const col = p.projects.filter((x) => x.stage === s);
          return (
            <section key={s} className="fs-board-col" role="listitem" aria-label={LABEL[s]}>
              <header className="fs-board-h"><span>{LABEL[s]}</span><span className="sp" /><span className="t-cap">{count(col.length)}</span></header>
              {col.map((x) => (
                <button key={x.id} type="button" className="fs-board-card" onClick={() => setOpen(x.id)} aria-label={`${x.number} ${x.title}`}>
                  <span className="l1">{x.number}</span>
                  <span className="l2">{x.customer ?? x.title}</span>
                  <span className="fs-flags">
                    {x.stuck && <Status kind="risk">{`${x.days_in_stage} d in stage`}</Status>}
                    {x.install_on && <Tag>{`Install ${x.install_on}`}</Tag>}
                    {x.is_commercial && <Tag tone="solid">Commercial</Tag>}
                    {x.readiness.map((r) => <Tag key={r.code} tone="warn">{words(r.code.replace('EQUIPMENT_', 'equipment ').replace('PERMIT_', 'permit '))}</Tag>)}
                    {(s === 'INSTALLED' || s === 'INSPECTED') && !x.final_billed && <Tag tone="neg">Not billed</Tag>}
                  </span>
                  {x.contract_cents != null && <span className="t-cap fs-mono">{money(x.contract_cents)}</span>}
                </button>
              ))}
            </section>
          );
        })}
      </div>
      {current && <InstallDrawer {...p} project={current} onClose={() => setOpen(null)} />}
    </>
  );
}
