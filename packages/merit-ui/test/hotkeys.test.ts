import { describe, expect, it, vi } from 'vitest';
import { ariaKeyshortcuts, chordKeys, eventStroke, normalizeChord } from '../src/hotkeys/chords';
import { HotkeyConflictError, createHotkeyRegistry, type HotkeyEvent } from '../src/hotkeys/registry';

function key(k: string, mods: Partial<Pick<HotkeyEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}, target?: unknown): HotkeyEvent & { prevented: boolean } {
  const e = {
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    target,
    defaultPrevented: false,
    prevented: false,
    preventDefault() {
      e.prevented = true;
      e.defaultPrevented = true;
    },
  };
  return e;
}

/** A fake element for target checks (no DOM needed). */
function el(tagName: string, opts: { type?: string; inModal?: boolean; editable?: boolean } = {}) {
  return {
    tagName,
    isContentEditable: opts.editable ?? false,
    getAttribute: (n: string) => (n === 'type' ? (opts.type ?? null) : null),
    closest: (sel: string) => (opts.inModal && sel.includes('aria-modal') ? {} : null),
  };
}

describe('chord grammar', () => {
  it('normalizes aliases and glyphs to one canonical form', () => {
    expect(normalizeChord('⌘K')).toBe('mod+k');
    expect(normalizeChord('Cmd+K')).toBe('mod+k');
    expect(normalizeChord('ctrl+k')).toBe('mod+k');
    expect(normalizeChord('⇧A')).toBe('shift+a');
    expect(normalizeChord('Shift+A')).toBe('shift+a');
    expect(normalizeChord('Esc')).toBe('escape');
    expect(normalizeChord('G H')).toBe('g h');
    expect(normalizeChord('/')).toBe('/');
    expect(normalizeChord('?')).toBe('?');
  });
  it('maps events to strokes (shifted symbols keep their character)', () => {
    expect(eventStroke(key('k', { metaKey: true }))).toBe('mod+k');
    expect(eventStroke(key('k', { ctrlKey: true }))).toBe('mod+k');
    expect(eventStroke(key('A', { shiftKey: true }))).toBe('shift+a');
    expect(eventStroke(key('?', { shiftKey: true }))).toBe('?');
    expect(eventStroke(key('Escape'))).toBe('escape');
    expect(eventStroke(key('Shift', { shiftKey: true }))).toBeNull();
  });
  it('prints keycaps the way the boards do', () => {
    expect(chordKeys('mod+k')).toEqual(['⌘K']);
    expect(chordKeys('mod+j')).toEqual(['⌘J']);
    expect(chordKeys('shift+a')).toEqual(['⇧', 'A']);
    expect(chordKeys('g h')).toEqual(['G', 'H']);
    expect(chordKeys('escape')).toEqual(['Esc']);
    expect(chordKeys('enter')).toEqual(['↵']);
    expect(chordKeys('↑ ↓')).toEqual(['↑', '↓']);
    expect(ariaKeyshortcuts('mod+k')).toBe('Meta+K Control+K');
    expect(ariaKeyshortcuts('shift+a')).toBe('Shift+A');
  });
});

describe('one registry, no double binding', () => {
  it('throws on a second binding of the same chord, under any spelling', () => {
    const r = createHotkeyRegistry({ onConflict: 'throw' });
    r.register({ chord: 'mod+k', handler: () => {}, owner: 'CmdkTrigger' });
    expect(() => r.register({ chord: '⌘K', handler: () => {}, owner: 'CommandBar' })).toThrow(HotkeyConflictError);
    expect(() => r.register({ chord: 'ctrl+k', handler: () => {} })).toThrow(/already bound by CmdkTrigger/);
  });

  it('throws when a single key collides with a sequence prefix, either way round', () => {
    const r = createHotkeyRegistry({ onConflict: 'throw' });
    r.register({ chord: 'g h', handler: () => {} });
    expect(() => r.register({ chord: 'g', handler: () => {} })).toThrow(HotkeyConflictError);
    const r2 = createHotkeyRegistry({ onConflict: 'throw' });
    r2.register({ chord: 'g', handler: () => {} });
    expect(() => r2.register({ chord: 'g j', handler: () => {} })).toThrow(HotkeyConflictError);
  });

  it('refuses (does not replace) in warn mode, and unregister frees the chord', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = createHotkeyRegistry({ onConflict: 'warn' });
    const first = vi.fn();
    const off = r.register({ chord: 'j', handler: first });
    r.register({ chord: 'j', handler: () => {} });
    expect(err).toHaveBeenCalledOnce();
    r.handle(key('j'));
    expect(first).toHaveBeenCalledOnce();
    off();
    expect(r.has('j')).toBe(false);
    expect(() => r.register({ chord: 'j', handler: () => {} })).not.toThrow();
    err.mockRestore();
  });

  it('a stale unregister cannot remove a newer binding', () => {
    const r = createHotkeyRegistry({ onConflict: 'throw' });
    const off1 = r.register({ chord: 'x', handler: () => {} });
    off1();
    const second = vi.fn();
    r.register({ chord: 'x', handler: second });
    off1();
    r.handle(key('x'));
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('routing', () => {
  it('fires ⌘K and prevents the browser default', () => {
    const r = createHotkeyRegistry();
    const open = vi.fn();
    r.register({ chord: 'mod+k', handler: open });
    const e = key('k', { metaKey: true });
    expect(r.handle(e)).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(e.prevented).toBe(true);
  });

  it('runs G-then-X go-to sequences within the timeout only', () => {
    let t = 0;
    const r = createHotkeyRegistry({ now: () => t, sequenceTimeout: 1000 });
    const home = vi.fn();
    const jobs = vi.fn();
    r.register({ chord: 'g h', handler: home });
    r.register({ chord: 'g j', handler: jobs });
    expect(r.handle(key('g'))).toBe(true);
    t = 400;
    r.handle(key('j'));
    expect(jobs).toHaveBeenCalledOnce();
    r.handle(key('g'));
    t = 2000;
    r.handle(key('h'));
    expect(home).not.toHaveBeenCalled();
  });

  it('ignores plain keys while typing, but ⌘ chords still work there', () => {
    const r = createHotkeyRegistry();
    const move = vi.fn();
    const open = vi.fn();
    r.register({ chord: 'j', handler: move });
    r.register({ chord: 'mod+k', handler: open });
    const input = el('INPUT', { type: 'search' });
    r.handle(key('j', {}, input));
    r.handle(key('j', {}, el('TEXTAREA')));
    r.handle(key('j', {}, el('DIV', { editable: true })));
    expect(move).not.toHaveBeenCalled();
    r.handle(key('k', { metaKey: true }, input));
    expect(open).toHaveBeenCalledOnce();
    // A focused checkbox is not typing: J still moves.
    r.handle(key('j', {}, el('INPUT', { type: 'checkbox' })));
    expect(move).toHaveBeenCalledOnce();
  });

  it('leaves keys inside an open modal to the modal', () => {
    const r = createHotkeyRegistry();
    const move = vi.fn();
    r.register({ chord: 'j', handler: move });
    r.handle(key('j', {}, el('BUTTON', { inModal: true })));
    expect(move).not.toHaveBeenCalled();
  });

  it('a declining handler (returns false) leaves the event alone; `when` gates', () => {
    const r = createHotkeyRegistry();
    let allowed = false;
    r.register({ chord: 'enter', handler: () => false });
    r.register({ chord: 'a', handler: () => {}, when: () => allowed });
    const e = key('Enter');
    expect(r.handle(e)).toBe(false);
    expect(e.prevented).toBe(false);
    expect(r.handle(key('a'))).toBe(false);
    allowed = true;
    expect(r.handle(key('a'))).toBe(true);
  });

  it('skips events another handler already prevented', () => {
    const r = createHotkeyRegistry();
    const fn = vi.fn();
    r.register({ chord: 'escape', handler: fn });
    const e = key('Escape');
    e.defaultPrevented = true;
    r.handle(e);
    expect(fn).not.toHaveBeenCalled();
  });

  it('lists bindings for a shortcut sheet', () => {
    const r = createHotkeyRegistry();
    r.register({ chord: 'mod+j', handler: () => {}, description: 'Switch company', owner: 'ContextChip' });
    expect(r.list()).toEqual([{ chord: 'mod+j', description: 'Switch company', owner: 'ContextChip' }]);
  });
});
