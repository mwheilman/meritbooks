/**
 * The fact sheet for "Summarize this view" (AC-W10) — built ONLY from the computed view the
 * reader is looking at (cards / blocks), each fact with a ref (F1…Fn). The model phrases; the
 * verifier (lib/close/flux/ai-draft.ts `verifyDraft`, the same guard the flux drafts use)
 * refuses any draft that cites an unknown ref, cites nothing, or quotes a $ / % that is not a
 * figure here. Tenant strings (company / customer / account names) pass through `promptSafe`.
 * PURE.
 */

import { promptSafe, type FactSheet } from '@/lib/close/flux/ai-draft';
import type { BlocksViewResponse, CardModel, DashboardViewResponse, ViewResponse, WsBlock, WsUnit, WsValue } from './types';
import { TAB_LABEL } from './types';
import { fmt } from './units';

export const MAX_FACTS = 60;

interface Fact {
  text: string;
  figures: Array<{ v: WsValue; unit: WsUnit }>;
}

const safe = (s: string) => promptSafe(s, 120);

function cardFact(c: CardModel): Fact {
  if (c.value === null) return { text: `${safe(c.name)}: cannot be computed (${safe(c.unavailable?.message ?? 'no figure')}).`, figures: [] };
  const figures: Fact['figures'] = [{ v: c.value, unit: c.unit }];
  let text = `${safe(c.name)} (${c.window.basis.toUpperCase()} to ${c.window.to}): ${fmt(c.value, c.unit)}`;
  if (c.comparison && c.comparison.value !== null) {
    figures.push({ v: c.comparison.value, unit: c.unit });
    text += `; ${c.comparison.label}: ${fmt(c.comparison.value, c.unit)}`;
    if (c.change) {
      const d = c.change.delta;
      figures.push({ v: Math.abs(d), unit: c.unit });
      text += `; change ${d >= 0 ? '+' : '-'}${fmt(Math.abs(d), c.unit)}${c.change.inPoints ? ' (points)' : ''}`;
      if (c.change.pct !== null) {
        figures.push({ v: Math.abs(c.change.pct) / 100, unit: 'percent' });
        text += ` (${c.change.pct.toFixed(1)}%)`;
      }
      text += ` — ${c.change.verdict}`;
    }
  }
  if (c.preliminary) text += ' [includes months not closed]';
  return { text, figures };
}

function blockFacts(b: WsBlock): Fact[] {
  const head = `${safe(b.title)}`;
  const out: Fact[] = [];
  const add = (text: string, figures: Fact['figures']) => out.push({ text: `${head} — ${text}`, figures });
  if (b.state) {
    out.push({ text: `${head}: not shown (${safe(b.state.kind === 'unavailable' ? b.state.detail : b.state.body)}).`, figures: [] });
    return out;
  }
  switch (b.kind) {
    case 'series': {
      const i = b.data.actual.length - 1;
      const p = b.data.periods[i];
      const figs: Fact['figures'] = [{ v: b.data.actual[i], unit: b.unit }];
      let t = `${p?.longLabel ?? ''}: ${fmt(b.data.actual[i], b.unit)}`;
      if (b.data.priorYear?.[i] != null) {
        figs.push({ v: b.data.priorYear[i], unit: b.unit });
        t += `; a year earlier ${fmt(b.data.priorYear[i], b.unit)}`;
        const a = b.data.actual[i];
        const py = b.data.priorYear[i];
        if (a !== null && py !== null) {
          figs.push({ v: Math.abs(a - py), unit: b.unit });
          if (py > 0) figs.push({ v: Math.abs(a - py) / py, unit: 'percent' });
        }
      }
      if (b.data.budget?.[i] != null) {
        figs.push({ v: b.data.budget[i], unit: b.unit });
        t += `; budget ${fmt(b.data.budget[i], b.unit)}`;
      }
      if (b.data.ttm?.[i] != null) {
        figs.push({ v: b.data.ttm[i], unit: b.unit });
        t += `; trailing twelve months ${fmt(b.data.ttm[i], b.unit)}`;
      }
      add(t, figs);
      break;
    }
    case 'multi_line':
      add(
        b.lines.map((l) => `${safe(l.label)} ${fmt(l.values[l.values.length - 1], b.unit)}`).join('; '),
        b.lines.map((l) => ({ v: l.values[l.values.length - 1], unit: b.unit })),
      );
      break;
    case 'yoy':
      for (const r of b.rows) {
        const cell = r.fytd;
        add(
          `${safe(r.label)} FYTD ${fmt(cell.current, r.unit)} vs ${fmt(cell.prior, r.unit)} a year earlier${r.unit === 'money' && cell.pct !== null ? ` (${cell.pct.toFixed(1)}%)` : r.unit === 'percent' && cell.points !== null ? ` (${cell.points.toFixed(1)} pts)` : ''}; TTM ${fmt(r.ttm.current, r.unit)}`,
          [
            { v: cell.current, unit: r.unit },
            { v: cell.prior, unit: r.unit },
            { v: cell.change === null ? null : Math.abs(cell.change), unit: r.unit },
            { v: cell.pct === null ? null : Math.abs(cell.pct) / 100, unit: 'percent' },
            { v: r.ttm.current, unit: r.unit },
          ],
        );
      }
      break;
    case 'cagr':
      for (const r of b.rows) add(`${safe(r.label)} CAGR ${r.rungs.map((g) => `${g}y ${fmt(g.value, 'percent')}`).join(', ')}`, r.rungs.map((g) => ({ v: g.value, unit: 'percent' as const })));
      break;
    case 'variance': {
      if (b.totals) add(`total actual ${fmt(b.totals.actual, b.unit)} vs plan ${fmt(b.totals.plan, b.unit)}, variance ${fmt(b.totals.variance, b.unit)}`, [{ v: b.totals.actual, unit: b.unit }, { v: b.totals.plan, unit: b.unit }, { v: Math.abs(b.totals.variance), unit: b.unit }]);
      for (const r of b.rows.slice(0, 8)) {
        if (r.actual === null || r.plan === null) continue;
        add(`${safe(r.label)}: actual ${fmt(r.actual, b.unit)}, plan ${fmt(r.plan, b.unit)}, variance ${fmt(r.actual - r.plan, b.unit)}${r.material ? ' (material)' : ''}`, [{ v: r.actual, unit: b.unit }, { v: r.plan, unit: b.unit }, { v: Math.abs(r.actual - r.plan), unit: b.unit }]);
      }
      break;
    }
    case 'bridge':
      add(b.steps.map((s) => `${safe(s.label)} ${s.kind === 'delta' && s.value >= 0 ? '+' : ''}${fmt(s.value, 'money')}`).join('; '), b.steps.map((s) => ({ v: Math.abs(s.value), unit: 'money' as const })));
      break;
    case 'aging': {
      const first = b.rows[0];
      if (first) add(`${safe(first.label)}: ${b.buckets.map((k, i) => `${k.label} ${fmt(first.values[i], 'money')}`).join(', ')}`, first.values.map((v) => ({ v, unit: 'money' as const })));
      break;
    }
    case 'share': {
      const total = b.items.reduce((s, i) => s + Math.max(0, i.value ?? 0), 0);
      for (const it of [...b.items].sort((x, y) => (y.value ?? 0) - (x.value ?? 0)).slice(0, 5)) {
        const sh = total > 0 && it.value !== null ? it.value / total : null;
        add(`${safe(it.label)} ${fmt(it.value, b.unit)}${sh !== null ? ` (${(sh * 100).toFixed(1)}% share)` : ''}`, [{ v: it.value, unit: b.unit }, { v: sh, unit: 'percent' }]);
      }
      break;
    }
    case 'league':
      for (const r of b.rows.slice(0, 8)) {
        add(`${safe(r.label)}: ${b.columns.map((c, i) => `${safe(c.label)} ${fmt(r.values[i], c.unit)}`).join(', ')}`, b.columns.map((c, i) => ({ v: r.values[i], unit: c.unit })));
      }
      break;
    case 'scatter':
      for (const p of b.points.slice(0, 10)) add(`${safe(p.label)}: growth ${fmt(p.x, b.xUnit)}, EBITDA margin ${fmt(p.y, b.yUnit)}`, [{ v: p.x, unit: b.xUnit }, { v: p.y, unit: b.yUnit }]);
      break;
    case 'heat':
      break;
    case 'seasonality':
      break;
    case 'tiles':
      add(b.tiles.map((t) => `${safe(t.label)} ${fmt(t.value, t.unit)}`).join('; '), b.tiles.map((t) => ({ v: t.value, unit: t.unit })));
      break;
    case 'gauges':
      for (const g of b.gauges) add(`${safe(g.label)}: ${fmt(g.value, g.unit)} vs threshold ${fmt(g.threshold, g.unit)}, headroom ${g.headroomPct === null ? 'n/a' : `${(g.headroomPct * 100).toFixed(1)}%`}, ${g.band}`, [{ v: g.value, unit: g.unit }, { v: g.threshold, unit: g.unit }, { v: g.headroomPct === null ? null : Math.abs(g.headroomPct), unit: 'percent' }]);
      break;
    default: {
      const never: never = b;
      return never;
    }
  }
  return out;
}

/** Build the fact sheet for a computed view. */
export function buildViewFactSheet(view: ViewResponse, scopeLabel: string): FactSheet & { lines: string[] } {
  const facts: Fact[] = [];
  if (view.tab === 'dashboard') for (const c of (view as DashboardViewResponse).cards) facts.push(cardFact(c));
  else for (const b of (view as BlocksViewResponse).blocks) facts.push(...blockFacts(b));
  const kept = facts.slice(0, MAX_FACTS);
  const allowedCents = new Set<number>();
  const allowedPct = new Set<number>();
  for (const f of kept) {
    for (const g of f.figures) {
      if (g.v === null || !Number.isFinite(g.v)) continue;
      if (g.unit === 'money') {
        allowedCents.add(Math.round(g.v));
        allowedCents.add(Math.abs(Math.round(g.v)));
      } else if (g.unit === 'percent') allowedPct.add(Math.round(Math.abs(g.v) * 10_000));
    }
  }
  const refs = kept.map((_, i) => `F${i + 1}`);
  const lines = kept.map((f, i) => `${refs[i]}: ${f.text}`);
  const header = [
    `View: ${TAB_LABEL[view.tab]} — ${promptSafe(scopeLabel, 160)}`,
    `Period: ${view.period.label}${view.period.comparisonLabel ? `, compared with ${view.period.comparisonLabel}` : ''}`,
    `Books closed through: ${view.governance.closedThrough ?? 'not closed'}${view.governance.preview ? ' (some figures are preliminary)' : ''}`,
    'Facts (cite by ref):',
  ];
  return { text: [...header, ...lines].join('\n'), allowedCents: [...allowedCents], allowedPctBps: [...allowedPct], refs, lines };
}

/** The deterministic summary (AI-down fallback and the refusal fallback): the blocks' own sentences. */
export function deterministicSummary(view: ViewResponse): string[] {
  if (view.tab === 'dashboard') return (view as DashboardViewResponse).cards.slice(0, 6).map((c) => c.summary);
  return (view as BlocksViewResponse).blocks.slice(0, 6).map((b) => b.summary);
}
