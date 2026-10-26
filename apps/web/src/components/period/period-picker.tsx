'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, Keys, Popover, PopoverFoot, Seg } from '@meritbooks/merit-ui';
import {
  comparisonName,
  fiscalYearOf,
  matchPreset,
  monthLabel,
  presetSelection,
  resolvePeriod,
  type PeriodBasis,
  type PeriodComparison,
  type PeriodPresetId,
  type PeriodSelection,
} from '@/lib/period/resolve';
import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  comparisonOptions,
  presetMeta,
  presetLabel,
  presetOptions,
  selectionForMonth,
  stepSelection,
  windowOptions,
} from '@/lib/period/picker-model';
import { closedThroughText } from '@/lib/period/closed';
import { MonthGrid } from './month-grid';
import type { PeriodContextData } from './use-period-context';
import s from './period-picker.module.css';

export interface PeriodPickerProps {
  value: PeriodSelection;
  onChange: (next: PeriodSelection) => void;
  /** Fiscal calendar + close state — from usePeriodParam().context / usePeriodContext(). */
  context: PeriodContextData;
  /** Windows the host can compute (default: all). ['month'] = a single-month report. */
  bases?: readonly PeriodBasis[];
  /** Comparisons the host can compute; omit to hide the comparison control. */
  comparisons?: readonly PeriodComparison[];
  /** compact = one 32px button; full = button + span + ‹ › stepper. */
  size?: 'compact' | 'full';
  /** ‹ › step buttons (default: on for full). */
  stepper?: boolean;
  /** Visible eyebrow before the control ("Reporting period"); also the accessible name. */
  label?: string;
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
  placement?: 'bottom-start' | 'bottom-end';
}

const KEY_HINTS: Array<{ chord: string; verb: string }> = [
  { chord: 'up down', verb: 'presets' },
  { chord: 'left right', verb: 'months' },
  { chord: 'enter', verb: 'choose' },
  { chord: 'escape', verb: 'close' },
];

/**
 * THE period control for Books. A button that reads the selection in plain English ("YTD 2026",
 * "TTM to Sep 2026", "Q3 2026", "FY 2025", "Jan–Mar 2026") and opens presets + a fiscal-year
 * month grid (closed months marked, future months inert) + an optional comparison.
 * Selection rules live in lib/period (pure, tested); URL/memory sync in usePeriodParam.
 */
export function PeriodPicker({
  value,
  onChange,
  context,
  bases,
  comparisons,
  size = 'full',
  stepper,
  label = 'Reporting period',
  showLabel = false,
  disabled,
  className,
  placement = 'bottom-start',
}: PeriodPickerProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const period = useMemo(() => resolvePeriod(value, context), [value, context]);
  const showStepper = stepper ?? size === 'full';
  const prev = useMemo(() => stepSelection(value, -1, context), [value, context]);
  const next = useMemo(() => stepSelection(value, 1, context), [value, context]);

  const openPopover = useCallback(() => {
    if (disabled) return;
    setNarrow(typeof window !== 'undefined' && window.innerWidth < 640);
    setOpen(true);
  }, [disabled]);

  const commit = useCallback(
    (sel: PeriodSelection, keepOpen = false) => {
      onChange(sel);
      if (!keepOpen) setOpen(false);
    },
    [onChange],
  );

  const sub = [period.monthCount > 1 ? period.spanLabel.split(' · ')[0] : null, period.comparison ? period.comparison.vsLabel : null].filter(Boolean).join(' · ');
  const aria = `${label}: ${period.label}${period.monthCount > 1 ? `, ${period.spanLabel}` : ''}${period.comparison ? `, ${period.comparison.vsLabel}` : ''}. Change period`;

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      openPopover();
    }
  };

  return (
    <div className={[s.root, className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {showLabel && <span className={s.eyebrow}>{label}</span>}
      {showStepper && (
        <Button
          variant="default"
          iconOnly
          icon="left"
          className={s.step}
          aria-label={prev ? `Previous: ${resolvePeriod(prev, context).label}` : 'Previous period'}
          disabled={disabled || !prev}
          onClick={() => prev && onChange(prev)}
        />
      )}
      <button
        ref={anchor}
        type="button"
        className={['btn', s.trigger].join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={aria}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPopover())}
        onKeyDown={onTriggerKey}
      >
        <Icon name="calendar" />
        <span className={s.trigLabel}>{period.label}</span>
        {size === 'full' && sub && <span className={s.trigSub}>{sub}</span>}
        {period.includesOpenMonths &&
          (size === 'full' ? (
            <span className={s.trigWarn} title="Includes months that are not closed yet — figures may still change">Preliminary</span>
          ) : (
            <i className={s.trigOpen} title="Includes months that are not closed yet — figures may still change" aria-hidden="true" />
          ))}
        <Icon name="down" />
      </button>
      {showStepper && (
        <Button
          variant="default"
          iconOnly
          icon="right"
          className={s.step}
          aria-label={next ? `Next: ${resolvePeriod(next, context).label}` : 'Next period (not available yet)'}
          disabled={disabled || !next}
          onClick={() => next && onChange(next)}
        />
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={narrow ? 340 : bases && bases.length === 1 && bases[0] === 'month' ? 560 : 744} placement={placement} aria-label={`Choose the ${label.toLowerCase()}`} autoFocus>
        {open && (
          <PickerBody value={value} context={context} bases={bases} comparisons={comparisons} narrow={narrow} onCommit={commit} />
        )}
      </Popover>
    </div>
  );
}

interface BodyProps {
  value: PeriodSelection;
  context: PeriodContextData;
  bases?: readonly PeriodBasis[];
  comparisons?: readonly PeriodComparison[];
  narrow: boolean;
  onCommit: (sel: PeriodSelection, keepOpen?: boolean) => void;
}

function PickerBody({ value, context, bases, comparisons, narrow, onCommit }: BodyProps) {
  const listId = useId();
  const presets = useMemo(() => presetOptions(bases), [bases]);
  const windows = useMemo(() => windowOptions(bases), [bases]);
  const cmpOpts = useMemo(() => comparisonOptions(comparisons), [comparisons]);
  const current = useMemo(() => value.preset ?? matchPreset(value, context, presets.map((p) => p.id)), [value, context, presets]);
  // Keyboard cursor in the preset list; -1 until the list is used (no phantom highlight).
  const [active, setActive] = useState(() => presets.findIndex((p) => p.id === current));
  const [basis, setBasis] = useState<PeriodBasis>(() => (windows.includes(value.basis) ? value.basis : windows[0] ?? 'month'));
  const [anchorMonth, setAnchorMonth] = useState<string | null>(null);
  const resolved = useMemo(() => resolvePeriod(value, context), [value, context]);
  const [fy, setFy] = useState(() => fiscalYearOf(value.end, context.fyStartMonth));
  const compare = value.compare ?? 'none';

  // A preset in "custom" means: switch the grid to range picking.
  const pickPreset = (id: PeriodPresetId) => {
    if (id === 'custom') {
      setBasis('range');
      setAnchorMonth(null);
      return;
    }
    const sel = presetSelection(id, context);
    onCommit({ ...sel, ...(compare !== 'none' ? { compare } : {}) });
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(presets.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => (i < 0 ? presets.length - 1 : Math.max(0, i - 1)));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(presets.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) pickPreset(presets[active].id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onPickMonth = (m: string) => {
    if (basis === 'range' && !anchorMonth) {
      setAnchorMonth(m);
      return;
    }
    onCommit(selectionForMonth(m, basis, compare, anchorMonth));
    setAnchorMonth(null);
  };

  // Switching the window re-anchors the current end month at once (keeps the popover open), so
  // "YTD" → "TTM" is one click; Range waits for two month clicks.
  const onWindow = (b: PeriodBasis) => {
    setBasis(b);
    setAnchorMonth(null);
    if (b !== 'range' && b !== value.basis) onCommit(selectionForMonth(value.end, b, compare), true);
  };

  useEffect(() => {
    setFy(fiscalYearOf(value.end, context.fyStartMonth));
  }, [value.end, context.fyStartMonth]);

  const hint =
    basis === 'range'
      ? anchorMonth
        ? <>From <b>{monthLabel(anchorMonth)}</b> — now pick the last month.</>
        : 'Pick the first month, then the last.'
      : BASIS_DESCRIPTIONS[basis];

  return (
    <>
      <div className={[s.body, windows.length <= 1 ? s.bodySlim : '', narrow ? s.bodyStack : ''].filter(Boolean).join(' ')}>
        <ul
          id={listId}
          role="listbox"
          aria-label="Presets"
          className={s.presets}
          tabIndex={0}
          data-autofocus
          aria-activedescendant={active >= 0 ? `${listId}-${presets[active].id}` : undefined}
          onKeyDown={onListKey}
        >
          {presets.map((p, i) => {
            const on = p.id === current || (p.id === 'custom' && basis === 'range');
            return (
              <li
                key={p.id}
                id={`${listId}-${p.id}`}
                role="option"
                aria-selected={on}
                className={[s.preset, i === active ? s.presetActive : '', on ? s.presetOn : ''].filter(Boolean).join(' ')}
                onMouseEnter={() => setActive(i)}
                onClick={() => pickPreset(p.id)}
              >
                <span className={s.presetCheck}>{on && <Icon name="check" />}</span>
                <span className={s.presetName}>{presetLabel(p, context)}</span>
                {p.id !== 'custom' && <span className={s.presetMeta}>{presetMeta(p.id, context)}</span>}
              </li>
            );
          })}
        </ul>

        <div className={s.side}>
          {windows.length > 1 && (
            <div>
              <div className={s.label} id={`${listId}-win`} style={{ marginBottom: 6 }}>Window</div>
              <Seg<PeriodBasis>
                aria-label="Window"
                className={s.seg}
                items={windows.map((b) => ({ value: b, label: BASIS_LABELS[b] }))}
                value={basis}
                onChange={onWindow}
              />
            </div>
          )}

          <MonthGrid
            fiscalYear={fy}
            onFiscalYear={setFy}
            basis={basis}
            window={{ start: resolved.start, end: resolved.end }}
            context={context}
            rangeAnchor={anchorMonth}
            onPick={onPickMonth}
          />
          <p className={s.hint} aria-live="polite">{hint}</p>
          <div className={s.legend}>
            <span><i className={s.markClosed} aria-hidden="true" /> Closed</span>
            <span><i className={s.markSoft} aria-hidden="true" /> Soft-closed</span>
            <span>Unmarked: open</span>
            <span>{closedThroughText(context.closedThrough, context.openBefore?.length ?? 0)}</span>
          </div>

          {cmpOpts.length > 1 && (
            <div>
              <div className={s.label} style={{ marginBottom: 6 }}>Compare with</div>
              <Seg<PeriodComparison>
                aria-label="Compare with"
                className={s.seg}
                items={cmpOpts.map((c) => ({ value: c, label: c === 'none' ? 'None' : comparisonName(c) }))}
                value={compare}
                onChange={(c) => onCommit({ ...value, compare: c }, true)}
              />
              {resolved.comparison && (
                <p className={s.hint} style={{ marginTop: 6 }}>
                  {resolved.comparison.kind === 'budget' ? `Budget for ${resolved.comparison.label}` : `${resolved.comparison.kindLabel}: ${resolved.comparison.label}`}
                </p>
              )}
            </div>
          )}

        </div>
      </div>
      <PopoverFoot className={s.foot}>
        <span className={s.footKeys}>
          {KEY_HINTS.map((k) => (
            <Keys key={k.chord} chord={k.chord}>{k.verb}</Keys>
          ))}
        </span>
        <span className="tnum">{resolved.spanLabel}</span>
      </PopoverFoot>
    </>
  );
}
