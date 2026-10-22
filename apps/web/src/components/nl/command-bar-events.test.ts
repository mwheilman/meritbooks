import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommandBarChord, isSearchChord } from './command-bar-events';

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe('global shortcut ownership (audit 06 §5 bugs 3/4)', () => {
  it('⌘K / Ctrl-K is the command-bar chord and NOT the search chord', () => {
    expect(isCommandBarChord(k('k', { metaKey: true }))).toBe(true);
    expect(isCommandBarChord(k('K', { ctrlKey: true }))).toBe(true);
    expect(isSearchChord(k('k', { metaKey: true }))).toBe(false);
  });

  it('⌘/ is the search chord and NOT the command-bar chord', () => {
    expect(isSearchChord(k('/', { metaKey: true }))).toBe(true);
    expect(isCommandBarChord(k('/', { metaKey: true }))).toBe(false);
  });

  it('plain keys and other modifiers do not match', () => {
    expect(isCommandBarChord(k('k'))).toBe(false);
    expect(isCommandBarChord(k('k', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchChord(k('/'))).toBe(false);
  });

  it('only the command bar binds ⌘K (the merit-ui shell opens it, never binds it twice)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const shell = fs.readFileSync(path.resolve(here, '../layout/books-shell.tsx'), 'utf8');
    // No hand-rolled ⌘K listener in the shell…
    expect(shell).not.toMatch(/toLowerCase\(\)\s*===\s*'k'|key\s*===\s*'k'/);
    // …and the kit's ⌘K trigger is told NOT to register the chord; it just opens the bar.
    expect(shell).toMatch(/<CmdkTrigger[^>]*onOpen=\{\(\) => openCommandBar\(\)\}[^>]*bindChord=\{false\}/);
  });
});
