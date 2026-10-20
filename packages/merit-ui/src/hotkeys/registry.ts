/**
 * ONE chord registry for the whole app (review 01 risk 10: ⌘K was double-bound
 * in Books). Every shortcut — ⌘K, ⌘J, /, G-then-X go-to, J/K/X/A/E/Esc in a
 * queue — registers here; nothing adds its own window keydown listener.
 *
 * Rules
 * - A chord can have exactly one live binding. Registering it again (or
 *   registering "g" while "g h" exists, or vice versa) is a conflict: it throws
 *   in development and is refused with a console error in production.
 * - Plain keys are ignored while the user types in a text field, select or
 *   contenteditable. ⌘ chords still work there (opt out per binding).
 * - Keys inside an open modal ([aria-modal="true"]) or a [data-hotkeys="off"]
 *   subtree are left to that subtree; the dialog owns Esc and Tab.
 * - A handler that returns false declines the event (no preventDefault).
 *
 * Pure TypeScript: it unit-tests without a DOM (test/hotkeys.test.ts).
 */
import { isDev } from '../cx';
import { eventStroke, normalizeChord, type KeyEventLike } from './chords';

export interface HotkeyEvent extends KeyEventLike {
  target?: unknown;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
}

export interface HotkeyBinding {
  chord: string;
  /** Return false to decline (the event continues, unprevented). */
  handler: (e: HotkeyEvent) => void | boolean;
  /** Shown in a shortcut sheet. */
  description?: string;
  /** Who registered it, for conflict messages ("QueueTable", "Rail · Job board"). */
  owner?: string;
  /** Fire while focus is in a text field. Default: true for ⌘ chords, false otherwise. */
  allowInInputs?: boolean;
  /** Checked at key time; false skips the binding without unregistering it. */
  when?: () => boolean;
}

export interface RegisteredHotkey {
  chord: string;
  description?: string;
  owner?: string;
}

export class HotkeyConflictError extends Error {
  constructor(
    public readonly chord: string,
    public readonly existingOwner: string | undefined,
    public readonly newOwner: string | undefined,
  ) {
    super(
      `Hotkey "${chord}" is already bound${existingOwner ? ` by ${existingOwner}` : ''}` +
        `${newOwner ? `; ${newOwner} cannot bind it again` : ''}. One chord, one action.`,
    );
    this.name = 'HotkeyConflictError';
  }
}

export interface HotkeyRegistryOptions {
  /** 'throw' (default outside production) or 'warn' (refuse + console.error). */
  onConflict?: 'throw' | 'warn';
  /** ms allowed between the two strokes of a sequence. */
  sequenceTimeout?: number;
  now?: () => number;
}

export interface HotkeyRegistry {
  /** Register a binding; returns its unregister function. */
  register(binding: HotkeyBinding): () => void;
  /** Route one keyboard event. Returns true when a binding consumed it. */
  handle(e: HotkeyEvent): boolean;
  /** Live bindings, for a shortcut sheet. */
  list(): RegisteredHotkey[];
  /** Is this chord bound right now? */
  has(chord: string): boolean;
  /** Attach the single keydown listener to a window/document; returns detach. */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void;
}

interface Entry extends HotkeyBinding {
  canonical: string;
  token: symbol;
}

interface ClosestCapable {
  closest(selector: string): unknown;
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
}

function asElement(t: unknown): ClosestCapable | null {
  if (t && typeof t === 'object' && typeof (t as ClosestCapable).closest === 'function') return t as ClosestCapable;
  return null;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** True when focus is somewhere the user is typing. */
export function isTypingTarget(target: unknown): boolean {
  const el = asElement(target);
  if (!el) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute?.('type') ?? 'text').toLowerCase();
    return !NON_TEXT_INPUTS.has(type);
  }
  return el.isContentEditable === true;
}

/** True when the target sits inside a subtree that owns its own keys. */
export function isIsolatedTarget(target: unknown): boolean {
  const el = asElement(target);
  if (!el) return false;
  return el.closest('[aria-modal="true"],[data-hotkeys="off"]') != null;
}

function defaultConflictMode(): 'throw' | 'warn' {
  return isDev() ? 'throw' : 'warn';
}

export function createHotkeyRegistry(options: HotkeyRegistryOptions = {}): HotkeyRegistry {
  const onConflict = options.onConflict ?? defaultConflictMode();
  const timeout = options.sequenceTimeout ?? 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  let pending: { stroke: string; at: number } | null = null;

  function conflictWith(canonical: string): Entry | undefined {
    const exact = entries.get(canonical);
    if (exact) return exact;
    const strokes = canonical.split(' ');
    if (strokes.length === 1) {
      // "g" conflicts with any "g …" sequence.
      for (const e of entries.values()) if (e.canonical.startsWith(`${canonical} `)) return e;
    } else {
      // "g h" conflicts with a bound "g".
      return entries.get(strokes[0] ?? '');
    }
    return undefined;
  }

  function register(binding: HotkeyBinding): () => void {
    const canonical = normalizeChord(binding.chord);
    const clash = conflictWith(canonical);
    if (clash) {
      const err = new HotkeyConflictError(canonical, clash.owner, binding.owner);
      if (onConflict === 'throw') throw err;
      // eslint-disable-next-line no-console
      console.error(`[merit-ui] ${err.message} The new binding was refused.`);
      return () => {};
    }
    const token = Symbol(canonical);
    entries.set(canonical, { ...binding, canonical, token });
    return () => {
      const cur = entries.get(canonical);
      if (cur && cur.token === token) entries.delete(canonical);
    };
  }

  function fire(entry: Entry, e: HotkeyEvent): boolean {
    if (entry.when && !entry.when()) return false;
    const result = entry.handler(e);
    if (result === false) return false;
    e.preventDefault?.();
    return true;
  }

  function allowed(entry: Entry, typing: boolean): boolean {
    if (!typing) return true;
    return entry.allowInInputs ?? entry.canonical.startsWith('mod+');
  }

  function handle(e: HotkeyEvent): boolean {
    if (e.defaultPrevented) return false;
    const stroke = eventStroke(e);
    if (!stroke) return false;
    if (isIsolatedTarget(e.target)) return false;
    const typing = isTypingTarget(e.target);

    if (pending) {
      const fresh = now() - pending.at <= timeout;
      const seq = `${pending.stroke} ${stroke}`;
      pending = null;
      if (fresh) {
        const entry = entries.get(seq);
        if (entry && allowed(entry, typing)) return fire(entry, e);
      }
    }

    const single = entries.get(stroke);
    if (single) {
      if (!allowed(single, typing)) return false;
      return fire(single, e);
    }

    if (!typing) {
      for (const entry of entries.values()) {
        if (entry.canonical.startsWith(`${stroke} `) && (!entry.when || entry.when())) {
          pending = { stroke, at: now() };
          return true;
        }
      }
    }
    return false;
  }

  function attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const listener = (ev: Event) => {
      handle(ev as KeyboardEvent);
    };
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  }

  return {
    register,
    handle,
    attach,
    has: (chord) => entries.has(normalizeChord(chord)),
    list: () => [...entries.values()].map(({ canonical, description, owner }) => ({ chord: canonical, description, owner })),
  };
}
