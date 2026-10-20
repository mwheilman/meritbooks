import { describe, expect, it, vi } from 'vitest';
import { TOAST_LIMIT, createToastStore } from '../src/overlays/toast-store';
import { pagerState } from '../src/tables/ListPager';
import { mergeScope } from '../src/hooks/useQuery';
import { withParams } from '../src/hooks/api';
import { placePeekCard } from '../src/overlays/HoverPeek';

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      pending.push({ fn, ms, id: ++id });
      return id;
    },
    clearTimer: (t: unknown) => {
      const i = pending.findIndex((p) => p.id === t);
      if (i >= 0) pending.splice(i, 1);
    },
    runAll: () => pending.splice(0).forEach((p) => p.fn()),
    pending,
  };
}

describe('toast store', () => {
  it('shows, auto-dismisses, and keeps undoable/error toasts longer', () => {
    const t = fakeTimers();
    const store = createToastStore(t);
    store.show('Approved 3 · posted to Heartland');
    store.show('Approved 1', { undo: () => {} });
    store.show("Couldn't post 1. September is soft-closed.", { tone: 'neg' });
    expect(store.getSnapshot().map((i) => i.duration)).toEqual([4000, 8000, 8000]);
    t.runAll();
    expect(store.getSnapshot()).toEqual([]);
  });

  it('caps the stack and notifies subscribers', () => {
    const store = createToastStore(fakeTimers());
    const l = vi.fn();
    store.subscribe(l);
    for (let i = 0; i < TOAST_LIMIT + 2; i++) store.show(`Approved ${i}`);
    expect(store.getSnapshot().length).toBe(TOAST_LIMIT);
    expect(store.getSnapshot()[0]?.message).toBe('Approved 2');
    expect(l).toHaveBeenCalledTimes(TOAST_LIMIT + 2);
  });

  it('dismiss clears the timer', () => {
    const t = fakeTimers();
    const store = createToastStore(t);
    const id = store.show('Sent to client');
    store.dismiss(id);
    expect(t.pending.length).toBe(0);
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe('ported pure helpers', () => {
  it('pagerState never silently stops at a page size', () => {
    expect(pagerState(1, 50, 213)).toEqual({ from: 1, to: 50, total: 213, page: 1, totalPages: 5, hasPrev: false, hasNext: true });
    expect(pagerState(9, 50, 213).page).toBe(5);
    expect(pagerState(1, 50, 0)).toMatchObject({ from: 0, to: 0, totalPages: 1 });
  });

  it('scope params merge under explicit params and can be opted out', () => {
    expect(mergeScope({ company_id: 'c-103' }, { status: 'open' }, true)).toEqual({ company_id: 'c-103', status: 'open' });
    expect(mergeScope({ company_id: 'c-103' }, { company_id: 'c-101' }, true)).toEqual({ company_id: 'c-101' });
    expect(mergeScope({ company_id: 'c-103' }, undefined, false)).toBeUndefined();
    expect(mergeScope({ company_id: null }, undefined, true)).toEqual({});
  });

  it('withParams merges into an existing query string', () => {
    expect(withParams('/api/jobs?status=open', { company_id: 'A', empty: '' })).toBe('/api/jobs?status=open&company_id=A');
    expect(withParams('/api/jobs?company_id=A', { company_id: 'A' })).toBe('/api/jobs?company_id=A');
  });

  it('peek cards stay on screen', () => {
    expect(placePeekCard({ anchorX: 1400, rowTop: 800, rowBottom: 848, viewportW: 1440, viewportH: 900, cardW: 340, cardH: 240 })).toEqual({ left: 1048, top: 556 });
  });
});
