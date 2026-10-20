/**
 * Single owner of ⌘K: the CPA Desk command bar (<CommandBar/>, mounted once in
 * the app layout). Other surfaces — the sidebar "CPA Desk" button, empty
 * states, etc. — open it through this event instead of binding ⌘K themselves
 * (audit 06 §5 bugs 3/4: the header also bound ⌘K, so two overlays opened, and
 * the sidebar button had no handler). Search keeps ⌘/ only.
 */
export const OPEN_COMMAND_BAR_EVENT = 'meritbooks:open-command-bar';

export interface OpenCommandBarDetail {
  /** Optional text to prefill the prompt with. */
  prompt?: string;
}

export function openCommandBar(detail: OpenCommandBarDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenCommandBarDetail>(OPEN_COMMAND_BAR_EVENT, { detail }));
}

/** True for the command-bar chord (⌘K / Ctrl-K), and nothing else. */
export function isCommandBarChord(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

/** True for the search-palette chord (⌘/ / Ctrl-/), and nothing else. */
export function isSearchChord(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key === '/';
}
