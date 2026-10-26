'use client';

/**
 * One KPI card (AC-W2): label with the (i) formula, the figure, the change chip with its
 * semantic word (improvement / erosion; favourable / unfavourable vs budget; points for
 * percent metrics), the sparkline (gaps stay gaps, preliminary months flagged), the benchmark
 * status as pip + word, and — when it cannot compute — the reason in words, never a 0.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button, Pip, Popover, type PipKind } from '@meritbooks/merit-ui';
import { Sparkline } from '@/components/charts';
import type { CardModel, CardSize } from '@/lib/fpna/workspace/types';
import { changeText, valueText, windowText } from './format';
import s from './fpna.module.css';

const STATUS: Record<'good' | 'watch' | 'poor', { pip: PipKind; word: string }> = {
  good: { pip: 'ready', word: 'On target' },
  watch: { pip: 'risk', word: 'Watch' },
  poor: { pip: 'overdue', word: 'Off target' },
};

export interface MetricCardProps {
  card: CardModel;
  size: CardSize;
  editing: boolean;
  index: number;
  count: number;
  removable: boolean;
  onDrill: (card: CardModel) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (metric: string) => void;
  onResize: (metric: string, size: CardSize) => void;
  dragIndex: number | null;
  setDragIndex: (i: number | null) => void;
}

export function MetricCard({ card, size, editing, index, count, removable, onDrill, onMove, onRemove, onResize, dragIndex, setDragIndex }: MetricCardProps) {
  const defRef = useRef<HTMLButtonElement>(null);
  const [defOpen, setDefOpen] = useState(false);
  const [over, setOver] = useState(false);
  const st = card.status ? STATUS[card.status] : null;
  const good = card.change ? (card.change.verdict === 'improvement' || card.change.verdict === 'favourable' ? true : card.change.verdict === 'erosion' || card.change.verdict === 'unfavourable' ? false : null) : null;
  const drillable = card.drill.some((d) => d.accountIds.length > 0) && card.value !== null;
  const sizeCls = size === 'l' ? s.cardL : size === 'm' ? s.cardM : '';

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!editing) {
      if ((e.key === 'Enter' || e.key === ' ') && drillable && e.target === e.currentTarget) {
        e.preventDefault();
        onDrill(card);
      }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      onMove(index, index - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      onMove(index, index + 1);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && removable) {
      e.preventDefault();
      onRemove(card.metric);
    }
  };

  const drag = editing
    ? {
        draggable: true,
        onDragStart: (e: DragEvent<HTMLElement>) => {
          setDragIndex(index);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', card.metric);
        },
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (dragIndex === null) return;
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent<HTMLElement>) => {
          e.preventDefault();
          setOver(false);
          if (dragIndex !== null && dragIndex !== index) onMove(dragIndex, index);
          setDragIndex(null);
        },
        onDragEnd: () => setDragIndex(null),
      }
    : {};

  return (
    <article
      className={`${s.card} ${sizeCls}`}
      data-editing={editing}
      data-dragover={over}
      tabIndex={0}
      aria-label={`${card.name}. ${card.summary}${editing ? ` Card ${index + 1} of ${count}. Arrow keys move it${removable ? ', Delete removes it' : ''}.` : drillable ? ' Press Enter to see the entries.' : ''}`}
      onKeyDown={onKey}
      onClick={() => !editing && drillable && onDrill(card)}
      style={{ cursor: !editing && drillable ? 'pointer' : undefined }}
      {...drag}
    >
      <div className={s.cardTop}>
        <span className={s.cardLabel}>
          {card.name}
          <button
            ref={defRef}
            type="button"
            className={s.mark}
            aria-label={`How ${card.name} is calculated`}
            aria-expanded={defOpen}
            onClick={(e) => {
              e.stopPropagation();
              setDefOpen((o) => !o);
            }}
          >
            i
          </button>
        </span>
        {st && (
          <span className={`status status--${st.pip}`}>
            <Pip kind={st.pip} />
            {st.word}
          </span>
        )}
      </div>
      <Popover open={defOpen} onClose={() => setDefOpen(false)} anchorRef={defRef} placement="bottom-start" width={340} aria-label={`${card.name} definition`}>
        <div style={{ maxWidth: 320, padding: 12 }}>
          <p style={{ margin: 0 }}>{card.definition}</p>
          <p className={s.muted} style={{ margin: '8px 0 0' }}>
            <b>Formula:</b> {card.formula}
          </p>
          {card.benchmarkSource && <p className={s.muted} style={{ margin: '8px 0 0' }}>Bands: {card.benchmarkSource}</p>}
          {card.notes.map((n) => (
            <p key={n} className={s.muted} style={{ margin: '8px 0 0' }}>{n}</p>
          ))}
          {card.scope.excluded.length > 0 && (
            <p className={s.muted} style={{ margin: '8px 0 0' }}>
              Left out: {card.scope.excluded.map((x) => `${x.name} (${x.message})`).join('; ')}
            </p>
          )}
        </div>
      </Popover>

      {card.value === null ? (
        <div className={s.cardNa} role="status">
          <span className={s.cardNaTitle}>{card.unavailable?.title ?? 'Not available'}</span>
          <span className={s.cardNaBody}>{card.unavailable?.message ?? 'This figure cannot be computed for the selection.'}</span>
        </div>
      ) : (
        <>
          <span className={s.cardValue}>{valueText(card.value, card.unit)}</span>
          {card.change && (
            <span className={`${s.chg} ${good === null ? s.neutral : good ? s.good : s.bad}`}>
              {card.change.arrow === 'up' ? '▲' : card.change.arrow === 'down' ? '▼' : '–'} {changeText(card)} · {card.change.sentence}
            </span>
          )}
          {!card.change && card.comparison?.unavailable && <span className={`${s.chg} ${s.neutral}`}>No comparison: {card.comparison.unavailable.title.toLowerCase()}</span>}
        </>
      )}

      {card.sparkline.length > 1 && (
        <Sparkline
          values={card.sparkline.map((p) => p.value)}
          unit={card.unit}
          metric={card.sparkBasis === 'month' && card.window.basis !== 'month' ? `${card.name}, by month` : card.name}
          labels={card.sparkline.map((p) => p.month)}
          statuses={card.sparkline.map((p) => (p.preliminary ? 'preliminary' : 'closed'))}
          width={size === 's' ? 180 : 360}
          height={28}
        />
      )}

      <div className={s.cardFoot}>
        <span>
          {windowText(card.window.basis, card.window.from, card.window.to)}
          {card.preliminary && <abbr className={s.mark} title="Preliminary — includes months that are not closed">P</abbr>}
        </span>
        {editing ? (
          <span className={s.cardBtns} onClick={(e) => e.stopPropagation()}>
            <Button size="md" variant="quiet" aria-label={`Move ${card.name} earlier`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>←</Button>
            <Button size="md" variant="quiet" aria-label={`Move ${card.name} later`} disabled={index === count - 1} onClick={() => onMove(index, index + 1)}>→</Button>
            <Button size="md" variant="quiet" aria-label={`Make ${card.name} ${size === 's' ? 'wider' : 'narrower'}`} onClick={() => onResize(card.metric, size === 's' ? 'm' : size === 'm' ? 'l' : 's')}>
              {size === 's' ? 'Wider' : size === 'm' ? 'Widest' : 'Narrow'}
            </Button>
            {removable ? (
              <Button size="md" variant="quiet" aria-label={`Remove ${card.name}`} onClick={() => onRemove(card.metric)}>Remove</Button>
            ) : (
              <span className={s.muted} title="Your administrator requires this card">Required</span>
            )}
          </span>
        ) : (
          card.comparison && <span>vs {card.comparison.label}</span>
        )}
      </div>
    </article>
  );
}
