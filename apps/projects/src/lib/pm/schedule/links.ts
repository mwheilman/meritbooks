/**
 * Predecessor text, as typed in the grid: `12FS+2d, 14SS-1d, 3`.
 *
 *   ref     a row number ("12", the # column) or a WBS code ("1.2.3", the WBS column)
 *   type    FS | SS | FF | SF, any case; FS when omitted
 *   lag     +/− working days: "+2", "+2d", "-1 day", "+1w" (a week is 5 working days); 0 when omitted
 *
 * Tokens are separated by commas or semicolons. Pure; the grid resolves refs to task ids
 * through a lookup and sends the result to pm.set_task_links as [{pred_id, dep_type, lag_days}].
 */
import { DEP_TYPES, LAG_MAX, LAG_MIN, type DepType, type SchedDep } from './types';

export interface LinkToken {
  /** As typed: "12" or "1.2". */
  ref: string;
  type: DepType;
  lag: number;
  /** The token as typed, for error messages. */
  text: string;
}

export interface ParsedLink {
  pred_id: string;
  dep_type: DepType;
  lag_days: number;
}

export type ParseResult = { ok: true; links: ParsedLink[] } | { ok: false; error: string };

const TOKEN = /^(\d+(?:\.\d+)*)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+)\s*(d|day|days|wd|w|wk|week|weeks)?)?$/i;

/** Tokenise without resolving refs. Returns the first syntax error, worded for the cell. */
export function tokenizeLinks(input: string): { ok: true; tokens: LinkToken[] } | { ok: false; error: string } {
  const parts = input.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const tokens: LinkToken[] = [];
  for (const text of parts) {
    const m = TOKEN.exec(text);
    if (!m) return { ok: false, error: `“${text}” is not a link. Type a row number, then FS, SS, FF or SF and a lag, like 12FS+2d.` };
    const type = (m[2] ?? 'FS').toUpperCase() as DepType;
    const unit = (m[5] ?? 'd').toLowerCase();
    const n = Number(m[4] ?? 0) * (unit.startsWith('w') && unit !== 'wd' ? 5 : 1);
    const lag = m[3] === '-' ? -n : n;
    if (lag < LAG_MIN || lag > LAG_MAX) return { ok: false, error: `The lag on “${text}” is out of range: keep it between ${LAG_MIN} and +${LAG_MAX} working days.` };
    tokens.push({ ref: m[1] as string, type, lag, text });
  }
  return { ok: true, tokens };
}

/**
 * Parse and resolve for one successor. `resolve(ref)` maps "12" / "1.2" to a task id (or null).
 * Refuses: unknown rows, a task linked to itself, the same predecessor twice, links to a summary.
 */
export function parseLinks(
  input: string,
  succId: string,
  resolve: (ref: string) => { id: string; summary: boolean } | null,
): ParseResult {
  const t = tokenizeLinks(input);
  if (!t.ok) return t;
  const links: ParsedLink[] = [];
  const seen = new Set<string>();
  for (const tok of t.tokens) {
    const hit = resolve(tok.ref);
    if (!hit) return { ok: false, error: `There is no row ${tok.ref} in this schedule.` };
    if (hit.id === succId) return { ok: false, error: `A task cannot follow itself (row ${tok.ref}).` };
    if (hit.summary) return { ok: false, error: `Row ${tok.ref} is a phase. Link to one of its tasks instead.` };
    if (seen.has(hit.id)) return { ok: false, error: `Row ${tok.ref} is listed twice. Keep one link to it.` };
    seen.add(hit.id);
    links.push({ pred_id: hit.id, dep_type: tok.type, lag_days: tok.lag });
  }
  return { ok: true, links };
}

/** One link as the grid shows it: "12", "12SS", "12FS+2d", "12FF-1d". */
export function formatLink(ref: string, type: DepType, lag: number): string {
  if (!lag) return type === 'FS' ? ref : `${ref}${type}`;
  return `${ref}${type}${lag > 0 ? '+' : '-'}${Math.abs(lag)}d`;
}

/** A successor's predecessors as text, in row order. `refOf(id)` gives the row number. */
export function formatLinks(deps: ReadonlyArray<SchedDep>, refOf: (id: string) => string | null, order?: (id: string) => number): string {
  const list = [...deps];
  if (order) list.sort((a, b) => order(a.pred_id) - order(b.pred_id));
  return list
    .map((d) => {
      const r = refOf(d.pred_id);
      return r ? formatLink(r, d.dep_type, d.lag_days) : null;
    })
    .filter((x): x is string => !!x)
    .join(', ');
}

export function isDepType(x: unknown): x is DepType {
  return typeof x === 'string' && (DEP_TYPES as readonly string[]).includes(x);
}

/** Plain words for a link type, for the side panel. */
export const DEP_WORDS: Readonly<Record<DepType, string>> = {
  FS: 'finish to start',
  SS: 'start to start',
  FF: 'finish to finish',
  SF: 'start to finish',
};
