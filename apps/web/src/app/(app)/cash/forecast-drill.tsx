'use client';

import { useEffect, useMemo } from 'react';
import { AppLink, Button, Drawer, KV, Tag } from '@meritbooks/merit-ui';
import { CATEGORY_LABEL } from '@/lib/cash/forecast/types';
import { CERTAINTY_WORD, FLAG_WORD, dayLabel, pctLabel, sourceHref, usd, usdCents, weekdayLabel, type Category, type ForecastItem, type ScopeForecast } from './cash-types';
import s from './cash.module.css';

export interface DrillSelection {
  weekIndex: number;
  /** A single day inside the week. */
  date?: string | null;
  category?: Category | null;
  /** Every week of the horizon (the bridge drills a category across all 13 weeks). */
  allWeeks?: boolean;
}

/**
 * Click a week / day / cell → the items composing it (U8, AC-CF11). ← → walk weeks, Esc closes.
 * Each item shows its timing basis (pay history, schedule, run-rate), certainty, probability, flags,
 * and a link to the source document.
 */
export function ForecastDrill({
  scope,
  items,
  selection,
  onChange,
  onClose,
  companyName,
}: {
  scope: ScopeForecast;
  items: ForecastItem[];
  selection: DrillSelection | null;
  onChange: (s: DrillSelection) => void;
  onClose: () => void;
  companyName: (id: string | null) => string;
}) {
  const week = selection ? scope.weeks[selection.weekIndex] : null;
  const list = useMemo(() => {
    if (!week || !selection) return [];
    return items
      .filter((i) => (selection.allWeeks ? true : i.date >= week.start && i.date <= week.end))
      .filter((i) => (selection.date ? i.date === selection.date : true))
      .filter((i) => (selection.category ? i.category === selection.category : true))
      .sort((a, b) => (a.direction !== b.direction ? (a.direction === 'IN' ? -1 : 1) : b.amountCents - a.amountCents));
  }, [items, week, selection]);

  useEffect(() => {
    if (!selection || selection.allWeeks) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowRight' && selection.weekIndex < scope.weeks.length - 1) {
        e.preventDefault();
        onChange({ weekIndex: selection.weekIndex + 1, category: selection.category ?? null });
      } else if (e.key === 'ArrowLeft' && selection.weekIndex > 0) {
        e.preventDefault();
        onChange({ weekIndex: selection.weekIndex - 1, category: selection.category ?? null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, scope.weeks.length, onChange]);

  if (!selection || !week) return null;
  const inflow = list.filter((i) => i.direction === 'IN').reduce((a, i) => a + i.amountCents, 0);
  const outflow = list.filter((i) => i.direction === 'OUT').reduce((a, i) => a + i.amountCents, 0);
  const day = selection.date ? scope.days.find((d) => d.date === selection.date) : null;
  const title = selection.allWeeks
    ? `All 13 weeks · ${dayLabel(scope.weeks[0].start)} – ${dayLabel(scope.weeks[scope.weeks.length - 1].end)}`
    : selection.date
      ? weekdayLabel(selection.date)
      : `Week ${week.weekNumber} · ${dayLabel(week.start)} – ${dayLabel(week.end)}`;
  const first = scope.weeks[0];
  const last = scope.weeks[scope.weeks.length - 1];

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      eyebrow={[scope.name, selection.category ? CATEGORY_LABEL[selection.category] : 'All items']}
      title={title}
      meta={`${list.length} item${list.length === 1 ? '' : 's'}${selection.allWeeks ? '' : ' · ← → change week'} · Esc closes`}
      figure={usd(inflow - outflow)}
      foot={
        <div className="row">
          <Button variant="quiet" icon="left" disabled={selection.weekIndex === 0} onClick={() => onChange({ weekIndex: selection.weekIndex - 1, category: selection.category ?? null })}>
            Previous week
          </Button>
          <span className="sp" />
          <Button variant="quiet" iconAfter="right" disabled={selection.weekIndex >= scope.weeks.length - 1} onClick={() => onChange({ weekIndex: selection.weekIndex + 1, category: selection.category ?? null })}>
            Next week
          </Button>
        </div>
      }
    >
      <KV
        items={[
          { term: day ? 'Opening (that morning)' : 'Opening', value: usd(day ? day.openingCents : selection.allWeeks ? first.openingCents : week.openingCents) },
          { term: 'Cash in', value: usd(inflow) },
          { term: 'Cash out', value: usd(outflow) },
          { term: day ? 'Closing (that night)' : 'Closing', value: usd(day ? day.closingCents : selection.allWeeks ? last.closingCents : week.closingCents) },
          ...(day || selection.allWeeks ? [] : [{ term: '80% range', value: `${usd(week.loCents)} – ${usd(week.hiCents)}` }]),
          ...(scope.minimumCents > 0 ? [{ term: 'Minimum cash', value: `${usd(scope.minimumCents)}${week.belowMinimum ? ' · below' : ''}` }] : []),
        ]}
      />
      {(selection.date || selection.category) && !selection.allWeeks && (
        <p style={{ margin: '8px 0' }}>
          <Button variant="quiet" onClick={() => onChange({ weekIndex: selection.weekIndex })}>
            Show the whole week
          </Button>
        </p>
      )}
      {list.length === 0 ? (
        <p className="t-cap" style={{ marginTop: 16 }}>
          Nothing is expected to move {selection.date ? 'that day' : 'that week'}{selection.category ? ` in ${CATEGORY_LABEL[selection.category].toLowerCase()}` : ''}.
        </p>
      ) : (
        <ul className={s.list} style={{ listStyle: 'none', padding: 0, margin: '16px 0 0' }}>
          {list.map((it) => {
            const href = sourceHref(it);
            return (
              <li key={it.key} className={s.listRow} style={{ alignItems: 'flex-start' }}>
                <div className={s.grow}>
                  <span className="l1">{it.label}</span>
                  <span className="l2">
                    {[it.party, companyName(it.companyId), dayLabel(it.date), CATEGORY_LABEL[it.category]].filter(Boolean).join(' · ')}
                  </span>
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                    <Tag tone={it.certainty === 'COMMITTED' ? 'solid' : it.certainty === 'ESTIMATED' ? 'warn' : 'default'}>{CERTAINTY_WORD[it.certainty]}</Tag>
                    {it.probability < 1 && <Tag tone="ai">{pctLabel(it.probability)} likely</Tag>}
                    {(it.flags ?? []).map((f) => (
                      <Tag key={f} tone={f === 'OVERDUE' || f === 'DISPUTED' || f === 'ON_HOLD' ? 'neg' : 'default'}>
                        {FLAG_WORD[f] ?? f}
                      </Tag>
                    ))}
                  </div>
                  {it.note && <p className="t-cap" style={{ marginTop: 4 }}>{it.note}</p>}
                  {it.breakdown && it.breakdown.length > 0 && (
                    <p className="t-cap" style={{ marginTop: 4 }}>
                      {it.breakdown.map((b) => `${b.label} ${usd(b.cents)}`).join(' · ')}
                    </p>
                  )}
                  {it.grossCents !== it.amountCents && <p className="t-cap">Document {usdCents(it.grossCents)} · counted {usdCents(it.amountCents)}</p>}
                  {href && (
                    <AppLink href={href} className="link">
                      Open the source
                    </AppLink>
                  )}
                </div>
                <span className={`tnum ${it.direction === 'IN' ? s.pos : ''}`} style={{ whiteSpace: 'nowrap' }}>
                  {it.direction === 'IN' ? '+' : '−'}
                  {usd(it.amountCents)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
