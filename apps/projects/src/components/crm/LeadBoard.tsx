'use client';

import { useState, type DragEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pip, compactMoney, count, money, shortDate, type PipKind } from '@meritbooks/merit-ui';
import { boardStages, durationWords } from '@/lib/crm/stages';
import type { Pipeline, StageRow } from '@/lib/crm/types';
import { weightedOf, type LeadView } from '@/lib/crm/view';
import type { MovableLead } from './useMoveLead';
import './crm.css';

export function movable(l: LeadView): MovableLead {
  return {
    id: l.id, title: l.title, pipelineId: l.pipelineId, stageId: l.stageId, customerId: l.customerId, hasContact: !!l.contactName,
    convertedJobId: l.convertedJobId, convertedEstimateId: l.convertedEstimateId,
  };
}

const SPEED_PIP: Readonly<Record<string, PipKind>> = { ready: 'ready', track: 'track', risk: 'risk', overdue: 'overdue' };

/**
 * The pipeline board for one company's pipeline: a column per stage (open stages, then won, then
 * lost). Drag a card to another column, or focus it and press Alt+← / Alt+→ to move one stage.
 * Click the title to open the lead.
 */
export function LeadBoard({ pipeline, leads, canEdit, showMoney, onMove }: {
  pipeline: Pipeline;
  leads: ReadonlyArray<LeadView>;
  canEdit: boolean;
  showMoney: boolean;
  onMove: (lead: MovableLead, toStageId: string) => void;
}) {
  const router = useRouter();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const stages = boardStages(pipeline.stages);
  const openStages = stages.filter((s) => s.kind === 'open');

  const drop = (e: DragEvent, stage: StageRow) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    const lead = leads.find((l) => l.id === id);
    if (lead && lead.stageId !== stage.id) onMove(movable(lead), stage.id);
  };

  const keyMove = (e: KeyboardEvent, l: LeadView) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      router.push(`/leads/${l.id}`);
      return;
    }
    if (!canEdit || !e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    const i = openStages.findIndex((s) => s.id === l.stageId);
    if (i < 0) return;
    const next = openStages[e.key === 'ArrowRight' ? i + 1 : i - 1];
    if (next) onMove(movable(l), next.id);
  };

  return (
    <div className="crm-board" role="list" aria-label={`${pipeline.name}, by stage`}>
      {stages.map((s) => {
        const ls = leads.filter((l) => l.stageId === s.id);
        const value = ls.reduce((t, l) => t + (l.amountCents ?? 0), 0);
        const weighted = ls.reduce((t, l) => t + (weightedOf(l) ?? 0), 0);
        return (
          <section
            key={s.id}
            role="listitem"
            aria-label={`${s.name}, ${ls.length} leads`}
            className={['crm-col', over === s.id ? 'is-over' : '', s.kind === 'won' ? 'is-won' : '', s.kind === 'lost' ? 'is-lost' : ''].filter(Boolean).join(' ')}
            onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(s.id); } : undefined}
            onDragLeave={canEdit ? () => setOver((o) => (o === s.id ? null : o)) : undefined}
            onDrop={canEdit ? (e) => drop(e, s) : undefined}
          >
            <header className="crm-col-h">
              <span className="t">{s.name}<span className="n">{count(ls.length)}</span></span>
              <span className="m">
                {showMoney
                  ? s.kind === 'open' ? `${compactMoney(value)} · ${compactMoney(weighted)} weighted at ${Math.round((s.probability_pct ?? 0))}%` : compactMoney(value)
                  : s.kind === 'open' ? `${Math.round(s.probability_pct ?? 0)}% likely to close` : s.kind === 'won' ? 'Won' : 'Lost'}
              </span>
            </header>
            <ul className="crm-col-body">
              {ls.length === 0 && <li className="crm-col-empty">{canEdit ? 'Drag a lead here' : 'No leads in this stage'}</li>}
              {ls.map((l) => {
                const attn = l.speed?.state === 'waiting' && l.speed.tone === 'overdue' || l.followupsOverdue > 0;
                return (
                  <li
                    key={l.id}
                    className={['crm-card', dragId === l.id ? 'is-dragging' : '', attn ? 'is-attn' : ''].filter(Boolean).join(' ')}
                    draggable={canEdit && !l.convertedJobId}
                    tabIndex={0}
                    aria-keyshortcuts={canEdit ? 'Alt+ArrowLeft Alt+ArrowRight Enter' : 'Enter'}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; setDragId(l.id); }}
                    onDragEnd={() => { setDragId(null); setOver(null); }}
                    onKeyDown={(e) => keyMove(e, l)}
                    onDoubleClick={() => router.push(`/leads/${l.id}`)}
                  >
                    <Link className="l1" href={`/leads/${l.id}`} draggable={false}>{l.title}</Link>
                    <span className="l2">{[l.customerName ?? l.contactName, l.site, l.company].filter(Boolean).join(' · ') || l.sourceLabel}</span>
                    <span className="row">
                      {showMoney && l.amountCents != null && <span className="amt">{money(l.amountCents, { decimals: 0 })}</span>}
                      <span>{l.ownerName ?? 'Unassigned'}</span>
                      <span className="sp" />
                      <span>{l.daysInStage}d</span>
                    </span>
                    {(l.speed?.state === 'waiting' || l.followupsDue > 0 || l.needsNextStep || l.nextStepOn) && (
                      <span className="row">
                        {l.speed?.state === 'waiting' ? (
                          <><Pip kind={SPEED_PIP[l.speed.tone] ?? 'risk'} /><span>No touch yet · {durationWords(l.speed.minutes)}</span></>
                        ) : l.followupsDue > 0 ? (
                          <><Pip kind={l.followupsOverdue ? 'overdue' : 'risk'} /><span>{count(l.followupsDue)} follow-up{l.followupsDue === 1 ? '' : 's'} due</span></>
                        ) : l.needsNextStep ? (
                          <><Pip kind="risk" /><span>No next step</span></>
                        ) : (
                          <><Pip kind="track" /><span>{l.nextStep ?? 'Next step'} · {shortDate(l.nextStepOn!)}</span></>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
