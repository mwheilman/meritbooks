/**
 * Chord grammar for the single hotkey registry.
 *
 *   "mod+k"   ⌘K on macOS, Ctrl+K elsewhere (either modifier matches)
 *   "shift+a" ⇧A
 *   "/"  "?"  "j"  "escape"  "enter"  "arrowdown"
 *   "g h"     a sequence: G, then H within the sequence timeout
 *
 * Aliases accepted on input: ⌘ cmd meta ctrl control → mod · ⇧ → shift ·
 * ⌥ option → alt · esc → escape · ↵ return → enter · ↑ ↓ ← → arrows.
 * Glyph forms like "⌘K" and "⇧A" parse too.
 */

export interface KeyStroke {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-case key name: "k", "/", "escape", "arrowdown". */
  key: string;
}

const MOD_ALIASES = new Set(['mod', 'cmd', 'command', 'meta', 'ctrl', 'control', '⌘', '⌃']);
const SHIFT_ALIASES = new Set(['shift', '⇧']);
const ALT_ALIASES = new Set(['alt', 'option', 'opt', '⌥']);
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  '↵': 'enter',
  '⏎': 'enter',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  space: ' ',
  spacebar: ' ',
};

/** Shifted symbols are matched by the character itself; shift is implied. */
function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

function canonicalStroke(s: KeyStroke): string {
  const parts: string[] = [];
  if (s.mod) parts.push('mod');
  if (s.alt) parts.push('alt');
  if (s.shift && !isSymbolKey(s.key)) parts.push('shift');
  parts.push(s.key === ' ' ? 'space' : s.key);
  return parts.join('+');
}

function parseStroke(raw: string): KeyStroke {
  const stroke: KeyStroke = { mod: false, alt: false, shift: false, key: '' };
  // Glyph prefixes with no "+": "⌘K", "⇧A", "⌘⇧P".
  let rest = raw.trim();
  for (;;) {
    const ch = rest[0];
    if (ch === '⌘' || ch === '⌃') stroke.mod = true;
    else if (ch === '⇧') stroke.shift = true;
    else if (ch === '⌥') stroke.alt = true;
    else break;
    rest = rest.slice(1);
  }
  let tokens: string[];
  if (rest === '+') tokens = ['+'];
  else if (rest.endsWith('++')) tokens = [...rest.slice(0, -2).split('+').filter(Boolean), '+'];
  else tokens = rest.split('+').filter(Boolean);
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    const last = i === tokens.length - 1;
    if (!last && MOD_ALIASES.has(t)) stroke.mod = true;
    else if (!last && SHIFT_ALIASES.has(t)) stroke.shift = true;
    else if (!last && ALT_ALIASES.has(t)) stroke.alt = true;
    else if (last) stroke.key = KEY_ALIASES[t] ?? t;
    else throw new Error(`Unknown modifier "${tok}" in chord "${raw}"`);
  });
  if (!stroke.key) throw new Error(`Chord "${raw}" has no key`);
  return stroke;
}

/** Parse a chord into its strokes (more than one = a sequence). */
export function parseChord(chord: string): KeyStroke[] {
  const trimmed = chord.trim();
  if (!trimmed) throw new Error('Empty chord');
  // A lone space is the space key; otherwise whitespace separates a sequence.
  const strokes = trimmed.split(/\s+/).map(parseStroke);
  if (strokes.length > 2) throw new Error(`Chord "${chord}": sequences are two strokes at most`);
  return strokes;
}

/** Canonical form, used as the registry key: "mod+k", "shift+a", "g h". */
export function normalizeChord(chord: string): string {
  return parseChord(chord).map(canonicalStroke).join(' ');
}

/** Minimal shape of a keyboard event the matcher needs (testable without a DOM). */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The canonical stroke for a keyboard event, or null for a bare modifier press. */
export function eventStroke(e: KeyEventLike): string | null {
  const raw = e.key;
  if (raw === 'Meta' || raw === 'Control' || raw === 'Shift' || raw === 'Alt' || raw === 'Dead' || raw === 'Unidentified') return null;
  const key = raw.toLowerCase();
  return canonicalStroke({ mod: e.metaKey || e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key });
}

const GLYPH: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  escape: 'Esc',
  enter: '↵',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
  tab: 'Tab',
  backspace: '⌫',
};

/**
 * Keycaps to print for a chord, matching the boards: "mod+k" → ["⌘K"],
 * "shift+a" → ["⇧", "A"], "g h" → ["G", "H"], "escape" → ["Esc"].
 * ⌘ chords are one cap ("⌘K", as the bar prints it); others one cap per key.
 */
export function chordKeys(chord: string): string[] {
  const out: string[] = [];
  for (const stroke of normalizeChord(chord).split(' ')) {
    const parts = stroke.split('+');
    const key = parts[parts.length - 1] ?? '';
    const label = GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1));
    const mods = parts.slice(0, -1);
    if (mods.includes('mod')) {
      out.push(`${mods.filter((m) => m !== 'mod').map((m) => GLYPH[m] ?? m).join('')}⌘${label}`);
    } else {
      for (const m of mods) out.push(GLYPH[m] ?? m);
      out.push(label);
    }
  }
  return out;
}

/** aria-keyshortcuts value: "mod+k" → "Meta+K Control+K". */
export function ariaKeyshortcuts(chord: string): string {
  const strokes = normalizeChord(chord).split(' ');
  const fmt = (modName: string) =>
    strokes
      .map((s) =>
        s
          .split('+')
          .map((p, i, arr) => {
            if (i < arr.length - 1) return p === 'mod' ? modName : p === 'shift' ? 'Shift' : p === 'alt' ? 'Alt' : p;
            if (p === 'escape') return 'Escape';
            if (p === 'enter') return 'Enter';
            if (p.startsWith('arrow')) return `Arrow${p.slice(5, 6).toUpperCase()}${p.slice(6)}`;
            return p.length === 1 ? p.toUpperCase() : p;
          })
          .join('+'),
      )
      .join(' ');
  const meta = fmt('Meta');
  return meta.includes('Meta') ? `${meta} ${fmt('Control')}` : meta;
}
